// Work package R6-B4: Remediation: exhume harness requires explicit paths and timeouts, no silent defaults or repairs (audit L-7)
// Requirements: L-7, 11.4, 11.14

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { describe, it } from "node:test";
import type {
  ExecutionBackend,
  ExecProcess,
  ExecRequest,
  ExecResult,
  Sandbox,
  SandboxSpec,
} from "../../lib/backend/types";
import {
  BindPathError,
  BindPathNotDirectoryError,
  BindPathNotFoundError,
  BindPathRequiredError,
  BindPathRootError,
  BindPathSegmentError,
  ExhumerHarness,
  RequiredSettingError,
  TimeoutRequiredError,
  WardenPathRequiredError,
  runExhumerHarness,
  validateBindPath,
  type CommandExecutionResult,
} from "../../lib/exhume/exhume-harness";

function createMockExecutionBackend(): {
  backend: ExecutionBackend;
  createdSpecs: SandboxSpec[];
} {
  const createdSpecs: SandboxSpec[] = [];
  const backend: ExecutionBackend = {
    async create(spec: SandboxSpec): Promise<Sandbox> {
      createdSpecs.push(spec);
      return {
        id: spec.idempotencyKey,
        async run(_req: ExecRequest): Promise<ExecResult> {
          return {
            logRef: `log-${spec.idempotencyKey}`,
            exitCode: 0,
            oomKilled: false,
            timedOut: false,
            stdoutTail: "ok",
            stderrTail: "",
          };
        },
        async exec(_req: ExecRequest): Promise<ExecProcess> {
          return {
            async wait() {
              return { exitCode: 0, timedOut: false, oomKilled: false };
            },
          };
        },
        async wait() {
          return { exitCode: 0, timedOut: false, oomKilled: false };
        },
        async stop() {},
        async destroy() {},
      };
    },
  };
  return { backend, createdSpecs };
}

describe("Work package R6-B4: Explicit paths and timeouts without silent defaults or repairs (audit L-7)", () => {
  describe("1. Missing bind path is refused and not repaired", () => {
    it("refuses a bind path that does not exist on disk with BindPathNotFoundError", () => {
      const nonExistent = path.resolve("builders/does-not-exist-" + Date.now());

      assert.throws(
        () => validateBindPath(nonExistent, "builders"),
        (err: unknown) => {
          assert.ok(err instanceof BindPathNotFoundError);
          assert.ok(err instanceof BindPathError);
          assert.ok(err instanceof Error);
          assert.match((err as Error).message, /does not exist/i);
          return true;
        }
      );
    });

    it("does not fall back to nearest existing ancestor or path.resolve", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "r6b4-bind-repair-"));
      try {
        // tmpBase exists, but tmpBase/builders/deep/missing does not exist
        const missingPath = path.join(tmpBase, "builders", "deep", "missing");

        assert.throws(
          () => validateBindPath(missingPath, "builders"),
          (err: unknown) => {
            assert.ok(err instanceof BindPathNotFoundError);
            // Must not repair to tmpBase or nearest ancestor
            assert.match((err as Error).message, /silent repairs and fallbacks are prohibited/i);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("refuses undefined, empty string, or whitespace bind paths", () => {
      assert.throws(() => validateBindPath(undefined), (err: unknown) => {
        assert.ok(err instanceof BindPathRequiredError);
        assert.ok(err instanceof RequiredSettingError);
        return true;
      });
      assert.throws(() => validateBindPath(""), BindPathRequiredError);
      assert.throws(() => validateBindPath("   "), BindPathRequiredError);
    });

    it("refuses a bind path that is a regular file instead of a directory", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "r6b4-file-check-"));
      try {
        const filePath = path.join(tmpBase, "builders");
        fs.writeFileSync(filePath, "not a directory", "utf-8");

        assert.throws(
          () => validateBindPath(filePath, "builders"),
          (err: unknown) => {
            assert.ok(err instanceof BindPathNotDirectoryError);
            assert.match((err as Error).message, /not a directory/i);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("refuses a dangling symlink bind path", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "r6b4-dangling-link-"));
      try {
        const targetPath = path.join(tmpBase, "nonexistent-target");
        const linkPath = path.join(tmpBase, "builders");
        fs.symlinkSync(targetPath, linkPath);

        assert.throws(
          () => validateBindPath(linkPath, "builders"),
          (err: unknown) => {
            assert.ok(err instanceof BindPathNotFoundError);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("refuses box provisioning when the specified bindPath does not exist", () => {
      const { backend } = createMockExecutionBackend();
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "r6b4-prov-missing-"));
      const wardenDir = path.join(tmpBase, "warden");
      fs.mkdirSync(wardenDir, { recursive: true });

      try {
        const nonExistentBuilders = path.join(tmpBase, "builders", "missing");
        assert.throws(
          () =>
            new ExhumerHarness({
              runId: "run-prov-missing",
              baseSha: "sha0010",
              backend,
              bindPath: nonExistentBuilders,
              wardenBindPath: wardenDir,
              wallClockTimeoutMs: 5000,
            }),
          (err: unknown) => {
            assert.ok(err instanceof BindPathNotFoundError);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });
  });

  describe("2. Path outside allowed root is refused", () => {
    it("refuses a path outside the configured allowedRoot", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "r6b4-allowed-root-"));
      try {
        const allowedRoot = path.join(tmpBase, "allowed_area");
        const outsideDir = path.join(tmpBase, "outside_area", "builders");
        fs.mkdirSync(allowedRoot, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });

        assert.throws(
          () => validateBindPath(outsideDir, "builders", allowedRoot),
          (err: unknown) => {
            assert.ok(err instanceof BindPathRootError);
            assert.ok(err instanceof BindPathError);
            assert.match((err as Error).message, /outside allowed root/i);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("refuses traversal via .. attempting to escape allowedRoot", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "r6b4-traversal-"));
      try {
        const allowedRoot = path.join(tmpBase, "allowed_area");
        const outsideDir = path.join(tmpBase, "outside_area", "builders");
        fs.mkdirSync(allowedRoot, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });

        // Path written relative to allowedRoot using '..' to escape
        const escapingPath = path.join(allowedRoot, "..", "outside_area", "builders");

        assert.throws(
          () => validateBindPath(escapingPath, "builders", allowedRoot),
          (err: unknown) => {
            assert.ok(err instanceof BindPathRootError);
            assert.match((err as Error).message, /outside allowed root/i);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("refuses a symlink inside allowedRoot that targets a directory outside allowedRoot", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "r6b4-symlink-root-"));
      try {
        const allowedRoot = path.join(tmpBase, "allowed_area");
        const outsideDir = path.join(tmpBase, "outside_area", "builders");
        fs.mkdirSync(allowedRoot, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });

        const symlinkInRoot = path.join(allowedRoot, "builders");
        fs.symlinkSync(outsideDir, symlinkInRoot);

        assert.throws(
          () => validateBindPath(symlinkInRoot, "builders", allowedRoot),
          (err: unknown) => {
            assert.ok(err instanceof BindPathRootError);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("accepts a directory inside allowedRoot that matches the expected segment", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "r6b4-valid-root-"));
      try {
        const allowedRoot = path.join(tmpBase, "allowed_area");
        const validDir = path.join(allowedRoot, "builders", "repo");
        fs.mkdirSync(validDir, { recursive: true });

        const validated = validateBindPath(validDir, "builders", allowedRoot);
        assert.equal(validated, fs.realpathSync(validDir));
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("enforces allowedRoot in ExhumerHarness constructor for bindPath and wardenBindPath", () => {
      const mockRunner = async (): Promise<CommandExecutionResult> => ({ exitCode: 0 });
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "r6b4-harness-root-"));
      try {
        const allowedRoot = path.join(tmpBase, "allowed_area");
        const outsideBuilders = path.join(tmpBase, "outside", "builders");
        const insideBuilders = path.join(allowedRoot, "builders");
        const outsideWarden = path.join(tmpBase, "outside", "warden");
        fs.mkdirSync(allowedRoot, { recursive: true });
        fs.mkdirSync(outsideBuilders, { recursive: true });
        fs.mkdirSync(insideBuilders, { recursive: true });
        fs.mkdirSync(outsideWarden, { recursive: true });

        // Bind path outside allowedRoot rejected
        assert.throws(
          () =>
            new ExhumerHarness({
              runId: "run-outside-bind",
              baseSha: "sha0011",
              runner: mockRunner,
              allowedRoot,
              bindPath: outsideBuilders,
              wallClockTimeoutMs: 5000,
            }),
          BindPathRootError
        );

        // Warden path outside allowedRoot rejected
        assert.throws(
          () =>
            new ExhumerHarness({
              runId: "run-outside-warden",
              baseSha: "sha0012",
              runner: mockRunner,
              allowedRoot,
              bindPath: insideBuilders,
              wardenBindPath: outsideWarden,
              wallClockTimeoutMs: 5000,
            }),
          BindPathRootError
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });
  });

  describe("3. Missing base, missing warden path, and missing wallClockTimeoutMs are refused with required-setting error", () => {
    it("refuses missing base with a required-setting error when provisioning boxes", async () => {
      const { backend } = createMockExecutionBackend();
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "r6b4-req-base-"));
      const wardenDir = path.join(tmpBase, "warden");
      fs.mkdirSync(wardenDir, { recursive: true });

      try {
        // Base is missing (bindPath and worktreeDir omitted)
        const harness = new ExhumerHarness({
          runId: "run-missing-base",
          baseSha: "sha0013",
          backend,
          wardenBindPath: wardenDir,
          wallClockTimeoutMs: 5000,
        });

        await assert.rejects(
          async () => harness.provisionBoxes(),
          (err: unknown) => {
            assert.ok(err instanceof RequiredSettingError, "Must be an instance of RequiredSettingError");
            assert.ok(err instanceof BindPathRequiredError, "Must be an instance of BindPathRequiredError");
            assert.match((err as Error).message, /bind path|base/i);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("refuses missing warden path with a required-setting error when provisioning boxes", async () => {
      const { backend } = createMockExecutionBackend();
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "r6b4-req-warden-"));
      const buildersDir = path.join(tmpBase, "builders");
      fs.mkdirSync(buildersDir, { recursive: true });

      try {
        // Warden path is missing (wardenBindPath and wardenDir omitted)
        const harness = new ExhumerHarness({
          runId: "run-missing-warden",
          baseSha: "sha0014",
          backend,
          bindPath: buildersDir,
          wallClockTimeoutMs: 5000,
        });

        await assert.rejects(
          async () => harness.provisionBoxes(),
          (err: unknown) => {
            assert.ok(err instanceof RequiredSettingError, "Must be an instance of RequiredSettingError");
            assert.ok(err instanceof WardenPathRequiredError, "Must be an instance of WardenPathRequiredError");
            assert.ok(err instanceof BindPathRequiredError, "Must be an instance of BindPathRequiredError");
            assert.match((err as Error).message, /warden/i);
            return true;
          }
        );
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("refuses missing wallClockTimeoutMs with a required-setting error in ExhumerHarness constructor", () => {
      const mockRunner = async (): Promise<CommandExecutionResult> => ({ exitCode: 0 });

      assert.throws(
        () =>
          new ExhumerHarness({
            runId: "run-missing-timeout",
            baseSha: "sha0015",
            runner: mockRunner,
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError, "Must be an instance of RequiredSettingError");
          assert.ok(err instanceof TimeoutRequiredError, "Must be an instance of TimeoutRequiredError");
          assert.match((err as Error).message, /wallClockTimeoutMs is required/i);
          return true;
        }
      );
    });

    it("refuses invalid wallClockTimeoutMs (zero, negative, NaN, non-integer) with a required-setting error", () => {
      const mockRunner = async (): Promise<CommandExecutionResult> => ({ exitCode: 0 });
      const invalidTimeouts = [0, -100, NaN, Infinity, -Infinity, 12.34, "5000" as unknown as number];

      for (const badVal of invalidTimeouts) {
        assert.throws(
          () =>
            new ExhumerHarness({
              runId: "run-bad-timeout",
              baseSha: "sha0016",
              runner: mockRunner,
              wallClockTimeoutMs: badVal,
            }),
          (err: unknown) => {
            assert.ok(err instanceof RequiredSettingError);
            assert.ok(err instanceof TimeoutRequiredError);
            return true;
          },
          `Expected timeout value ${String(badVal)} to be refused with RequiredSettingError`
        );
      }
    });

    it("refuses runExhumerHarness call when wallClockTimeoutMs is omitted", async () => {
      const mockRunner = async (): Promise<CommandExecutionResult> => ({ exitCode: 0 });

      await assert.rejects(
        async () =>
          runExhumerHarness({
            runId: "run-func-no-timeout",
            baseSha: "sha0017",
            runner: mockRunner,
          }),
        (err: unknown) => {
          assert.ok(err instanceof RequiredSettingError);
          assert.ok(err instanceof TimeoutRequiredError);
          return true;
        }
      );
    });

    it("verifies error hierarchy: BindPathRequiredError, WardenPathRequiredError, and TimeoutRequiredError all extend RequiredSettingError", () => {
      const bindErr = new BindPathRequiredError();
      const wardenErr = new WardenPathRequiredError();
      const timeoutErr = new TimeoutRequiredError();

      assert.ok(bindErr instanceof RequiredSettingError);
      assert.ok(bindErr instanceof Error);

      assert.ok(wardenErr instanceof RequiredSettingError);
      assert.ok(wardenErr instanceof BindPathRequiredError);
      assert.ok(wardenErr instanceof Error);

      assert.ok(timeoutErr instanceof RequiredSettingError);
      assert.ok(timeoutErr instanceof Error);
    });
  });
});
