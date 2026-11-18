import test from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleSandboxExec } from "../../lib/gateway/execution-tools";
import type {
  SandboxExecRefusedResult,
  ToolExecutionContext,
} from "../../lib/gateway/types";

test("R4A1: an absolute path outside the worktree is refused and its content never appears in output or events", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4a1-wt-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4a1-outside-"));
  try {
    const outsideSecretPayload = "CANARY_SECRET_PAYLOAD_ABC_9876543210";
    const outsideFile = path.join(outsideDir, "external-payload.txt");
    fs.writeFileSync(outsideFile, `${outsideSecretPayload}\n`);

    const emittedEvents: Array<{ kind: string; runId: string; data: Record<string, unknown> }> = [];
    const context: ToolExecutionContext = {
      skeletonId: "skel-r4a1-abs",
      role: "Soul-stitcher",
      bearerToken: "token-r4a1-1",
      worktreeRoot: worktreeDir,
      runId: "run-r4a1-abs",
    };

    let runnerExecuted = false;
    const res = (await handleSandboxExec(
      {
        argv: ["git", "status"],
        files: [outsideFile],
      },
      context,
      {
        onEmitEvent: (e) => {
          emittedEvents.push(e as any);
        },
        runbox: (async () => {
          runnerExecuted = true;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    )) as SandboxExecRefusedResult;

    assert.equal(res.status, "refused");
    assert.equal(res.code, "PATH_ESCAPE");
    assert.equal(runnerExecuted, false, "Sandbox must not run when path escapes worktree");

    // Outside file content must never appear in response
    const resJson = JSON.stringify(res);
    assert.equal(
      resJson.includes(outsideSecretPayload),
      false,
      "Result must never leak outside file contents"
    );

    // Security event recorded
    assert.equal(emittedEvents.length, 1);
    assert.equal(emittedEvents[0].kind, "command.refused");
    assert.equal(emittedEvents[0].data.ruleId, "PATH_ESCAPE");
    assert.equal(emittedEvents[0].data.securityEvent, true);

    // Outside file content must never appear in emitted event
    const eventJson = JSON.stringify(emittedEvents[0]);
    assert.equal(
      eventJson.includes(outsideSecretPayload),
      false,
      "Refusal event must never leak outside file contents"
    );
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("R4A1: a relative .. path and a symlink escape are refused", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4a1-rel-sym-wt-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4a1-rel-sym-outside-"));
  try {
    const outsideSecretPayload = "CANARY_RELATIVE_SYMLINK_SECRET_123456";
    const outsideFile = path.join(outsideDir, "outside-secret.txt");
    fs.writeFileSync(outsideFile, `${outsideSecretPayload}\n`);

    const emittedEvents: Array<{ kind: string; runId: string; data: Record<string, unknown> }> = [];
    const context: ToolExecutionContext = {
      skeletonId: "skel-r4a1-rel",
      role: "Soul-stitcher",
      bearerToken: "token-r4a1-2",
      worktreeRoot: worktreeDir,
      runId: "run-r4a1-rel",
    };

    // Subtest A: relative .. path leaving worktree
    const relRes = (await handleSandboxExec(
      {
        argv: ["git", "status"],
        files: ["../outside-escape.txt"],
      },
      context,
      {
        onEmitEvent: (e) => {
          emittedEvents.push(e as any);
        },
      }
    )) as SandboxExecRefusedResult;

    assert.equal(relRes.status, "refused");
    assert.equal(relRes.code, "PATH_ESCAPE");

    // Subtest B: relative .. path inside a nested dir leaving worktree
    const nestedRelRes = (await handleSandboxExec(
      {
        argv: ["git", "status"],
        files: ["sub/../../outside-escape.txt"],
      },
      context,
    )) as SandboxExecRefusedResult;

    assert.equal(nestedRelRes.status, "refused");
    assert.equal(nestedRelRes.code, "PATH_ESCAPE");

    // Subtest C: symlink escape pointing outside worktree
    const symlinkPath = path.join(worktreeDir, "symlink_outside.txt");
    fs.symlinkSync(outsideFile, symlinkPath);

    emittedEvents.length = 0;
    const symRes = (await handleSandboxExec(
      {
        argv: ["git", "status"],
        files: ["symlink_outside.txt"],
      },
      context,
      {
        onEmitEvent: (e) => {
          emittedEvents.push(e as any);
        },
      }
    )) as SandboxExecRefusedResult;

    assert.equal(symRes.status, "refused");
    assert.equal(symRes.code, "PATH_ESCAPE");

    // Symlink target contents must never appear in response or event
    assert.equal(JSON.stringify(symRes).includes(outsideSecretPayload), false);
    assert.equal(JSON.stringify(emittedEvents).includes(outsideSecretPayload), false);
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("R4A1: an empty params.files does not hide a secret placed in the worktree", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4a1-hide-secret-"));
  try {
    const secretFile = path.join(worktreeDir, "credentials.env");
    fs.writeFileSync(
      secretFile,
      "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE999\n"
    );

    const context: ToolExecutionContext = {
      skeletonId: "skel-r4a1-empty",
      role: "Soul-stitcher",
      bearerToken: "token-r4a1-3",
      worktreeRoot: worktreeDir,
      runId: "run-r4a1-empty",
    };

    let runnerExecuted = false;
    const res = (await handleSandboxExec(
      {
        argv: ["git", "status"],
        files: [], // Empty array must NOT hide secret on disk
      },
      context,
      {
        runbox: (async () => {
          runnerExecuted = true;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        }) as any,
      }
    )) as SandboxExecRefusedResult;

    assert.equal(res.status, "refused");
    assert.equal(res.code, "SECRET_DETECTED");
    assert.equal(runnerExecuted, false, "Sandbox must not run when secret exists in worktree");
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("R4A1: union of caller lists merges context.files and options.worktreeFiles even when params.files is empty", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4a1-union-"));
  try {
    const contextSecretFile = path.join(worktreeDir, "context-secret.txt");
    fs.writeFileSync(
      contextSecretFile,
      "GITHUB_TOKEN=ghp_ContextSecretToken12345678901234\n"
    );

    const context: ToolExecutionContext = {
      skeletonId: "skel-r4a1-union",
      role: "Soul-stitcher",
      bearerToken: "token-r4a1-4",
      worktreeRoot: worktreeDir,
      runId: "run-r4a1-union",
    };
    (context as any).files = [contextSecretFile];

    const res = (await handleSandboxExec(
      {
        argv: ["git", "status"],
        files: [], // Empty params.files must NOT hide context.files
      },
      context
    )) as SandboxExecRefusedResult;

    assert.equal(res.status, "refused");
    assert.equal(res.code, "SECRET_DETECTED");
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test("R4A1: a refusal event contains no matched secret text and carries only path, ruleId and fingerprint", async () => {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4a1-nofingerprint-"));
  try {
    const rawSecret = "ghp_RawSecretStringToFingerprint12345678";
    const secretFile = path.join(worktreeDir, "secret-token.env");
    fs.writeFileSync(secretFile, `TOKEN=${rawSecret}\n`);

    const emittedEvents: Array<{ kind: string; runId: string; data: Record<string, unknown> }> = [];
    const context: ToolExecutionContext = {
      skeletonId: "skel-r4a1-fp",
      role: "Soul-stitcher",
      bearerToken: "token-r4a1-5",
      worktreeRoot: worktreeDir,
      runId: "run-r4a1-fp",
    };

    const res = (await handleSandboxExec(
      {
        argv: ["git", "status"],
      },
      context,
      {
        onEmitEvent: (e) => {
          emittedEvents.push(e as any);
        },
      }
    )) as SandboxExecRefusedResult;

    assert.equal(res.status, "refused");
    assert.equal(res.code, "SECRET_DETECTED");

    // 1. Result must not contain raw secret
    const resJson = JSON.stringify(res);
    assert.equal(
      resJson.includes(rawSecret),
      false,
      "Refusal result must not contain raw secret"
    );

    // 2. Refusal event must not contain raw secret
    assert.equal(emittedEvents.length, 1);
    const event = emittedEvents[0];
    assert.equal(event.kind, "command.refused");
    const eventJson = JSON.stringify(event);
    assert.equal(
      eventJson.includes(rawSecret),
      false,
      "Refusal event must not contain raw secret"
    );

    // 3. Expected fingerprint is first 12 hex of sha256(rawSecret)
    const expectedFingerprint = crypto
      .createHash("sha256")
      .update(rawSecret)
      .digest("hex")
      .slice(0, 12);

    // 4. Verify findings shape on event
    const eventFindings = event.data.findings as Array<{
      path: string;
      ruleId: string;
      fingerprint: string;
    }>;
    assert.ok(Array.isArray(eventFindings));
    assert.equal(eventFindings.length, 1);
    assert.equal(eventFindings[0].fingerprint, expectedFingerprint);
    assert.equal("match" in eventFindings[0], false);
    assert.equal("excerpt" in eventFindings[0], false);
    assert.deepEqual(Object.keys(eventFindings[0]).sort(), ["fingerprint", "path", "ruleId"]);

    // 5. Verify findings shape on res
    assert.ok(res.findings);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].fingerprint, expectedFingerprint);
    assert.equal("match" in (res.findings[0] as any), false);
    assert.equal("excerpt" in (res.findings[0] as any), false);
    assert.deepEqual(Object.keys(res.findings[0]).sort(), ["fingerprint", "path", "ruleId"]);
  } finally {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  }
});
