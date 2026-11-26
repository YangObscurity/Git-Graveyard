/**
 * Task 20.1: Bonesetter template validation, write boundary, bounded steering
 * resources and isolated session provisioning.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  BONESETTER_MANIFEST_ALLOW_PATTERNS,
  BONESETTER_MAX_STEERING_CHARS,
  BONESETTER_MAX_STEERING_FILES,
  BONESETTER_ROOT_MANIFEST_FILENAMES,
  BonesetterWriteDeniedError,
  bundleBonesetterSteeringResources,
  createBonesetterToolClient,
  isBonesetterWritablePath,
  prepareBonesetterSession,
  validateBonesetterTemplate,
} from "../../lib/agents/bonesetter";
import { CLAUDE_SONNET_5_5_MODEL_ID } from "../../lib/agents/model-allowlist";
import {
  MANIFEST_LOCK_FILENAMES,
  decide as brokerDecide,
} from "../../lib/broker/permission-broker";

const TEMPLATE_PATH = path.resolve(
  __dirname,
  "../../lib/agents/templates/bonesetter.md"
);

function readTemplate(): string {
  return fs.readFileSync(TEMPLATE_PATH, "utf-8");
}

describe("validateBonesetterTemplate", () => {
  it("accepts the committed bonesetter.md", () => {
    const info = validateBonesetterTemplate();

    assert.equal(info.policyPreset, "read-workspace");
    assert.equal(info.includeMcpJson, false);
    assert.equal(info.includePowers, false);
    assert.deepEqual(info.excludedTools, ["shell", "web", "subagent"]);
    assert.deepEqual(info.manifestAllowPatterns, [
      ...BONESETTER_MANIFEST_ALLOW_PATTERNS,
    ]);
    for (const tool of [
      "read",
      "write",
      "sandbox_exec",
      "sandbox_log",
      "report_task_result",
      "ask",
      "report_blocker",
      "ack_message",
    ]) {
      assert.ok(info.tools.includes(tool), `tools contains ${tool}`);
    }
  });

  it("accepts the committed template by explicit path", () => {
    const info = validateBonesetterTemplate(TEMPLATE_PATH);
    assert.equal(info.policyPreset, "read-workspace");
  });

  it("rejects a non read-workspace policy preset", () => {
    const tampered = readTemplate().replace(
      "policyPreset: read-workspace",
      "policyPreset: edit-workspace"
    );
    assert.notEqual(tampered, readTemplate());
    assert.throws(
      () => validateBonesetterTemplate(tampered),
      /policyPreset must be "read-workspace"/
    );
  });

  it("rejects includeMcpJson: true", () => {
    const tampered = readTemplate().replace(
      "includeMcpJson: false",
      "includeMcpJson: true"
    );
    assert.throws(
      () => validateBonesetterTemplate(tampered),
      /includeMcpJson must be false/
    );
  });

  it("rejects includePowers: true", () => {
    const tampered = readTemplate().replace(
      "includePowers: false",
      "includePowers: true"
    );
    assert.throws(
      () => validateBonesetterTemplate(tampered),
      /includePowers must be false/
    );
  });

  it("rejects an excludedTools list that drops subagent", () => {
    const tampered = readTemplate().replace("  - subagent\n", "");
    assert.notEqual(tampered, readTemplate());
    assert.throws(
      () => validateBonesetterTemplate(tampered),
      /excludedTools must contain "subagent"/
    );
  });

  it("rejects a missing fs_read secret deny glob", () => {
    const tampered = readTemplate().replace('        - "**/.env"\n', "");
    assert.notEqual(tampered, readTemplate());
    assert.throws(
      () => validateBonesetterTemplate(tampered),
      /fs_read deny rule must cover "\*\*\/\.env"/
    );
  });

  it("rejects a missing fs_write .git deny glob", () => {
    const tampered = readTemplate().replace('        - "**/.git/**"\n', "");
    assert.notEqual(tampered, readTemplate());
    assert.throws(
      () => validateBonesetterTemplate(tampered),
      /fs_write deny rule must cover "\*\*\/\.git\/\*\*"/
    );
  });

  it("rejects an fs_write allow rule that covers a non-manifest glob", () => {
    const tampered = readTemplate().replace(
      '        - "**/requirements*.txt"\n',
      '        - "**/requirements*.txt"\n        - "**/src/**"\n'
    );
    assert.notEqual(tampered, readTemplate());
    assert.throws(
      () => validateBonesetterTemplate(tampered),
      /fs_write allow rule must only cover manifest\/lockfile globs/
    );
  });

  it("rejects content without frontmatter", () => {
    assert.throws(
      () => validateBonesetterTemplate("name: bonesetter\nnot: frontmatter"),
      /missing YAML frontmatter/
    );
  });
});

describe("isBonesetterWritablePath", () => {
  it("allows exactly the 10 allowed manifest/lockfile names at the cwd root", () => {
    // Intersection of the broker MANIFEST_LOCK_FILENAMES and the Bonesetter
    // template allow patterns.
    const expected = [
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
    assert.deepEqual(
      [...BONESETTER_ROOT_MANIFEST_FILENAMES].sort(),
      [...expected].sort()
    );
    for (const name of [
      "package.json",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "poetry.lock",
      "Pipfile",
      "Pipfile.lock",
      "pyproject.toml",
      "requirements.txt",
    ]) {
      assert.equal(isBonesetterWritablePath(name), true, `${name} should be allowed`);
    }
  });

  it("denies broker-only manifest names absent from the template allowlist", () => {
    assert.equal(isBonesetterWritablePath("cargo.toml"), false);
    assert.equal(isBonesetterWritablePath("setup.cfg"), false);
    assert.equal(isBonesetterWritablePath("go.mod"), false);
    assert.equal(isBonesetterWritablePath("Gemfile"), false);
  });

  it("denies nested manifest paths and out-of-scope names (G01a)", () => {
    assert.equal(isBonesetterWritablePath("packages/app/package.json"), false);
    assert.equal(isBonesetterWritablePath("nested/requirements-dev.txt"), false);
    assert.equal(isBonesetterWritablePath("packages/app/yarn.lock"), false);
    assert.equal(isBonesetterWritablePath("setup.py"), false);
    assert.equal(isBonesetterWritablePath("requirements-dev.txt"), false);
  });

  it("asserts exact parity with the PermissionBroker Bonesetter fs_write scope", () => {
    const cwd = "/workspace/repo";
    const cases: Array<[string, boolean]> = [
      ["package.json", true],
      ["poetry.lock", true],
      ["packages/app/package.json", false],
      ["setup.py", false],
      ["requirements-dev.txt", false],
      ["src/index.ts", false],
      [".env", false],
      [".git/config", false],
      ["../package.json", false],
    ];

    assert.ok(MANIFEST_LOCK_FILENAMES.has("package.json"));
    assert.ok(MANIFEST_LOCK_FILENAMES.has("poetry.lock"));
    assert.equal(MANIFEST_LOCK_FILENAMES.has("setup.py"), false);
    assert.equal(MANIFEST_LOCK_FILENAMES.has("requirements-dev.txt"), false);

    for (const [candidate, allowed] of cases) {
      assert.equal(
        isBonesetterWritablePath(candidate),
        allowed,
        `isBonesetterWritablePath(${candidate})`
      );
      const decision = brokerDecide({
        role: "Bonesetter",
        cwd,
        capability: "fs_write",
        target: candidate,
        options: [
          { optionId: "a", kind: "allow_once" },
          { optionId: "r", kind: "reject_once" },
        ],
      });
      assert.equal(
        decision.optionKind === "allow_once",
        allowed,
        `PermissionBroker decide(${candidate})`
      );
    }
  });

  it("rejects arbitrary source files", () => {
    assert.equal(isBonesetterWritablePath("src/index.ts"), false);
    assert.equal(isBonesetterWritablePath("lib/app.js"), false);
    assert.equal(isBonesetterWritablePath("main.py"), false);
    assert.equal(isBonesetterWritablePath("README.md"), false);
  });

  it("rejects protected directories and secrets", () => {
    assert.equal(isBonesetterWritablePath(".git/config"), false);
    assert.equal(isBonesetterWritablePath(".kiro/hooks/a.json"), false);
    assert.equal(isBonesetterWritablePath(".env"), false);
    assert.equal(isBonesetterWritablePath("nested/.env.local"), false);
    assert.equal(isBonesetterWritablePath("certs/server.pem"), false);
    assert.equal(isBonesetterWritablePath("keys/id_rsa"), false);
  });

  it("rejects traversal and absolute paths", () => {
    assert.equal(isBonesetterWritablePath("../package.json"), false);
    assert.equal(isBonesetterWritablePath("nested/../../package.json"), false);
    assert.equal(isBonesetterWritablePath("/etc/package.json"), false);
    assert.equal(isBonesetterWritablePath(""), false);
  });
});

describe("bundleBonesetterSteeringResources", () => {
  it("writes guidance and reports counts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-steering-"));
    try {
      const result = bundleBonesetterSteeringResources({
        targetDir: dir,
        grimoireGuidance: [
          { fileName: "m1.md", content: "rule m1" },
          { fileName: "m2.md", content: "rule m2" },
        ],
      });
      assert.equal(result.totalFiles, 2);
      assert.equal(result.files.length, 2);
      assert.equal(result.rejected.length, 0);
      assert.ok(fs.existsSync(path.join(dir, "m1.md")));
      assert.ok(fs.existsSync(path.join(dir, "m2.md")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces at most 32 files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-steering-"));
    try {
      const guidance = Array.from({ length: 40 }, (_, i) => ({
        fileName: `g-${i}.md`,
        content: `guidance ${i}`,
      }));
      const result = bundleBonesetterSteeringResources({
        targetDir: dir,
        grimoireGuidance: guidance,
      });
      assert.equal(result.totalFiles, BONESETTER_MAX_STEERING_FILES);
      assert.equal(result.totalFiles, 32);
      assert.equal(result.rejected.length, 40 - 32);
      assert.equal(fs.readdirSync(dir).length, 32);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces at most 100,000 characters in total", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-steering-"));
    try {
      const result = bundleBonesetterSteeringResources({
        targetDir: dir,
        grimoireGuidance: [
          { fileName: "big.md", content: "x".repeat(BONESETTER_MAX_STEERING_CHARS + 5000) },
        ],
      });
      assert.ok(result.totalChars <= BONESETTER_MAX_STEERING_CHARS);
      assert.equal(result.totalChars, BONESETTER_MAX_STEERING_CHARS);
      assert.equal(result.truncated, true);
      assert.equal(result.files[0].chars, BONESETTER_MAX_STEERING_CHARS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never writes outside the target directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-steering-"));
    try {
      const result = bundleBonesetterSteeringResources({
        targetDir: dir,
        grimoireGuidance: [{ fileName: "../../escape.md", content: "nope" }],
      });
      assert.equal(result.files.length, 1);
      assert.equal(path.dirname(result.files[0].filePath), dir);
      assert.equal(result.files[0].fileName, "escape.md");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createBonesetterToolClient", () => {
  it("forwards a manifest write and denies a source write", async () => {
    const forwarded: string[] = [];
    const client = createBonesetterToolClient({
      read: async () => ({}),
      write: async (args) => {
        forwarded.push(args.path);
        return { ok: true };
      },
      sandboxExec: async () => ({}),
      sandboxLog: async () => ({}),
      reportTaskResult: async () => ({}),
      ask: async () => ({}),
      reportBlocker: async () => ({}),
      ackMessage: async () => ({}),
    });

    await client.write({ path: "package.json", content: "{}" });
    assert.deepEqual(forwarded, ["package.json"]);

    await assert.rejects(
      () => client.write({ path: "src/index.ts", content: "x" }),
      BonesetterWriteDeniedError
    );
    assert.deepEqual(forwarded, ["package.json"]);
  });
});

describe("prepareBonesetterSession", () => {
  it("provisions isolated HOME/KIRO_HOME and pinned Sonnet 5.5", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-bonesetter-"));
    try {
      const worktreeDir = path.join(base, "worktree");
      fs.mkdirSync(worktreeDir, { recursive: true });

      const prepared = prepareBonesetterSession({
        runId: "run-1",
        skeletonId: "skel-1",
        worktreeDir,
        baseDir: path.join(base, "runs"),
        grimoireGuidance: [{ fileName: "m1.md", content: "modernize request" }],
      });

      assert.equal(prepared.modelId, CLAUDE_SONNET_5_5_MODEL_ID);
      assert.equal(prepared.policyPreset, "read-workspace");
      assert.deepEqual(prepared.manifestAllowPatterns, [
        ...BONESETTER_MANIFEST_ALLOW_PATTERNS,
      ]);

      // Isolated directories exist and are distinct.
      assert.ok(fs.existsSync(prepared.paths.homeDir));
      assert.ok(fs.existsSync(prepared.paths.kiroHomeDir));
      assert.notEqual(prepared.paths.homeDir, prepared.paths.kiroHomeDir);

      // The role template is copied into the Skeleton's agent folders.
      assert.ok(fs.existsSync(path.join(prepared.paths.homeAgentsDir, "bonesetter.md")));
      assert.ok(fs.existsSync(path.join(prepared.paths.agentsDir, "bonesetter.md")));

      // Steering resources are written inside the worktree.
      const expectedSteeringDir = path.join(worktreeDir, ".kiro", "steering");
      assert.equal(prepared.steeringDir, expectedSteeringDir);
      assert.equal(prepared.steeringFiles.length, 1);
      assert.ok(prepared.steeringFiles[0].startsWith(expectedSteeringDir));
      assert.ok(fs.existsSync(prepared.steeringFiles[0]));
      assert.equal(fs.readFileSync(prepared.steeringFiles[0], "utf-8"), "modernize request");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("provisions distinct HOME trees for two skeletons", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-bonesetter-"));
    try {
      const worktreeDir = path.join(base, "worktree");
      fs.mkdirSync(worktreeDir, { recursive: true });
      const a = prepareBonesetterSession({
        runId: "run-2",
        skeletonId: "skel-a",
        worktreeDir,
        baseDir: path.join(base, "runs"),
      });
      const b = prepareBonesetterSession({
        runId: "run-2",
        skeletonId: "skel-b",
        worktreeDir,
        baseDir: path.join(base, "runs"),
      });
      assert.notEqual(a.paths.homeDir, b.paths.homeDir);
      assert.notEqual(a.paths.kiroHomeDir, b.paths.kiroHomeDir);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("validates a tampered custom templatesDir/bonesetter.md instead of the default", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-bonesetter-custom-"));
    try {
      const worktreeDir = path.join(base, "worktree");
      fs.mkdirSync(worktreeDir, { recursive: true });
      const templatesDir = path.join(base, "templates");
      fs.mkdirSync(templatesDir, { recursive: true });
      const tampered = readTemplate().replace(
        "includeMcpJson: false",
        "includeMcpJson: true"
      );
      assert.notEqual(tampered, readTemplate());
      fs.writeFileSync(path.join(templatesDir, "bonesetter.md"), tampered, "utf-8");

      assert.throws(
        () =>
          prepareBonesetterSession({
            runId: "run-custom",
            skeletonId: "skel-custom",
            worktreeDir,
            baseDir: path.join(base, "runs"),
            templatesDir,
          }),
        /includeMcpJson must be false/
      );

      // The tampered template must never have been provisioned into the Skeleton.
      assert.equal(
        fs.existsSync(path.join(base, "runs", "run-custom", "homes", "skel-custom")),
        false
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a custom templatesDir whose template widens the write boundary", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-bonesetter-custom-"));
    try {
      const worktreeDir = path.join(base, "worktree");
      fs.mkdirSync(worktreeDir, { recursive: true });
      const templatesDir = path.join(base, "templates");
      fs.mkdirSync(templatesDir, { recursive: true });
      const tampered = readTemplate().replace(
        '        - "**/requirements*.txt"\n',
        '        - "**/requirements*.txt"\n        - "**/src/**"\n'
      );
      assert.notEqual(tampered, readTemplate());
      fs.writeFileSync(path.join(templatesDir, "bonesetter.md"), tampered, "utf-8");

      assert.throws(
        () =>
          prepareBonesetterSession({
            runId: "run-custom2",
            skeletonId: "skel-custom2",
            worktreeDir,
            baseDir: path.join(base, "runs"),
            templatesDir,
          }),
        /fs_write allow rule must only cover manifest\/lockfile globs/
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("throws cleanly when a custom templatesDir has no bonesetter.md", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-bonesetter-custom-"));
    try {
      const worktreeDir = path.join(base, "worktree");
      fs.mkdirSync(worktreeDir, { recursive: true });
      const templatesDir = path.join(base, "templates");
      fs.mkdirSync(templatesDir, { recursive: true });

      assert.throws(
        () =>
          prepareBonesetterSession({
            runId: "run-custom3",
            skeletonId: "skel-custom3",
            worktreeDir,
            baseDir: path.join(base, "runs"),
            templatesDir,
          }),
        /Invalid Bonesetter template: file not found/
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  it("rejects a custom templatesDir whose bonesetter.json is not a regular file", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-bonesetter-custom-"));
    try {
      const worktreeDir = path.join(base, "worktree");
      fs.mkdirSync(worktreeDir, { recursive: true });
      const templatesDir = path.join(base, "templates");
      fs.mkdirSync(templatesDir, { recursive: true });
      // `skeleton-env.ts` prefers `bonesetter.json` over `bonesetter.md`, so a
      // directory mistakenly named `bonesetter.json` would be selected and then
      // fail to be read. A valid sibling `bonesetter.md` must NOT silently shadow
      // it: the invalid entry is rejected immediately.
      fs.mkdirSync(path.join(templatesDir, "bonesetter.json"), { recursive: true });
      fs.writeFileSync(path.join(templatesDir, "bonesetter.md"), readTemplate(), "utf-8");

      assert.throws(
        () =>
          prepareBonesetterSession({
            runId: "run-custom-dir",
            skeletonId: "skel-custom-dir",
            worktreeDir,
            baseDir: path.join(base, "runs"),
            templatesDir,
          }),
        /is not a file/
      );

      // The failure happened before any provisioning touched disk.
      assert.equal(
        fs.existsSync(path.join(base, "runs", "run-custom-dir", "homes", "skel-custom-dir")),
        false
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });



  it("accepts a compliant custom templatesDir and provisions its template", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-bonesetter-custom-"));
    try {
      const worktreeDir = path.join(base, "worktree");
      fs.mkdirSync(worktreeDir, { recursive: true });
      const templatesDir = path.join(base, "templates");
      fs.mkdirSync(templatesDir, { recursive: true });
      fs.writeFileSync(path.join(templatesDir, "bonesetter.md"), readTemplate(), "utf-8");

      const prepared = prepareBonesetterSession({
        runId: "run-custom-ok",
        skeletonId: "skel-custom-ok",
        worktreeDir,
        baseDir: path.join(base, "runs"),
        templatesDir,
      });

      assert.equal(prepared.modelId, CLAUDE_SONNET_5_5_MODEL_ID);
      assert.deepEqual(prepared.manifestAllowPatterns, [
        ...BONESETTER_MANIFEST_ALLOW_PATTERNS,
      ]);
      // The validated custom template is the one copied into the Skeleton.
      assert.equal(
        fs.readFileSync(path.join(prepared.paths.homeAgentsDir, "bonesetter.md"), "utf-8"),
        readTemplate()
      );
      assert.ok(fs.existsSync(path.join(prepared.paths.agentsDir, "bonesetter.md")));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("treats an empty or whitespace-only templatesDir as the default", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-bonesetter-custom-"));
    try {
      const worktreeDir = path.join(base, "worktree");
      fs.mkdirSync(worktreeDir, { recursive: true });

      const prepared = prepareBonesetterSession({
        runId: "run-ws",
        skeletonId: "skel-ws",
        worktreeDir,
        baseDir: path.join(base, "runs"),
        templatesDir: "   ",
      });

      assert.deepEqual(prepared.manifestAllowPatterns, [
        ...BONESETTER_MANIFEST_ALLOW_PATTERNS,
      ]);
      assert.ok(fs.existsSync(path.join(prepared.paths.homeAgentsDir, "bonesetter.md")));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
