// Work package R3-K: Exhume harness bind path and timeout rules (L-7)
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
  BindPathRequiredError,
  BindPathSegmentError,
  ExhumerHarness,
  TimeoutExceededError,
  TimeoutRequiredError,
  TimeoutSettingRequiredError,
  resolveWallClockTimeout,
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

describe("Work package R3-K: Exhume harness bind path and timeout (L-7)", () => {
  describe("Bind path validation and default removal (L-7)", () => {
    it("does not default worktreeDir to builders/base when caller omits it", () => {
      const mockRunner = async (): Promise<CommandExecutionResult> => ({ exitCode: 0 });
      const harness = new ExhumerHarness({
        runId: "run-no-default",
        baseSha: "sha0001",
        runner: mockRunner,
        wallClockTimeoutMs: 60000,
      });

      // Default to builders/base is removed; caller must provide bind path
      assert.equal(harness.worktreeDir, undefined);
    });

    it("requires bind path: caller must give bind path", () => {
      assert.throws(
        () => validateBindPath(undefined),
        (err: unknown) => {
          assert.ok(err instanceof BindPathRequiredError);
          assert.match((err as Error).message, /bind path is required/i);
          return true;
        }
      );

      assert.throws(
        () => validateBindPath(""),
        (err: unknown) => {
          assert.ok(err instanceof BindPathRequiredError);
          assert.match((err as Error).message, /bind path is required/i);
          return true;
        }
      );

      assert.throws(
        () => validateBindPath("   "),
        (err: unknown) => {
          assert.ok(err instanceof BindPathRequiredError);
          return true;
        }
      );
    });

    it("rejects string containment bypasses where 'builders' is not a distinct path segment", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "exhume-bindpath-neg-"));
      // Substrings that contain 'builders' but are not the segment 'builders'
      const invalidPaths = [
        path.join(tmpBase, "builders_fake", "worktree"),
        path.join(tmpBase, "mybuilders", "dir"),
        path.join(tmpBase, "fakebuilders", "job"),
        path.join(tmpBase, "builders-suffix", "data"),
      ];

      for (const p of invalidPaths) {
        fs.mkdirSync(p, { recursive: true });
      }
      try {
        for (const p of invalidPaths) {
          assert.throws(
            () => validateBindPath(p, "builders"),
            (err: unknown) => {
              assert.ok(err instanceof BindPathSegmentError);
              assert.match((err as Error).message, /segment mismatch/i);
              return true;
            },
            `Expected path '${p}' to be rejected due to segment mismatch`
          );
        }
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("accepts valid paths having 'builders' as an exact path segment", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "exhume-bindpath-pos-"));
      const validPaths = [
        path.join(tmpBase, "builders", "base"),
        path.join(tmpBase, "work", "builders", "worktree-1"),
        path.join(tmpBase, "data", "jobs", "builders", "run-42"),
      ];

      for (const p of validPaths) {
        fs.mkdirSync(p, { recursive: true });
      }
      try {
        for (const p of validPaths) {
          const resolved = validateBindPath(p, "builders");
          const segments = resolved.split(/[/\\]+/).filter(Boolean);
          assert.ok(segments.includes("builders"));
        }
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("resolves realpath before comparing segments and catches escaping symlinks", () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "exhume-bindpath-"));
      try {
        const targetOutside = path.join(tmpBase, "outside_dir");
        fs.mkdirSync(targetOutside, { recursive: true });

        // Symlink named "builders" pointing to outside directory
        const symlinkPath = path.join(tmpBase, "builders");
        fs.symlinkSync(targetOutside, symlinkPath);

        // realpath resolves to targetOutside which lacks "builders" segment
        assert.throws(
          () => validateBindPath(symlinkPath, "builders"),
          (err: unknown) => {
            assert.ok(err instanceof BindPathSegmentError);
            return true;
          }
        );

        // Conversely, a symlink pointing into a valid builders path succeeds
        const realBuilders = path.join(tmpBase, "builders_real_dir", "builders", "worktree");
        fs.mkdirSync(realBuilders, { recursive: true });
        const aliasLink = path.join(tmpBase, "alias_link");
        fs.symlinkSync(realBuilders, aliasLink);

        const result = validateBindPath(aliasLink, "builders");
        const segs = result.split(/[/\\]+/).filter(Boolean);
        assert.ok(segs.includes("builders"));
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
      }
    });

    it("validates warden bind path segments similarly", () => {
      const exploitDir = "/tmp/warden_exploit/dir";
      const validWarden = "/tmp/warden/box-1";
      fs.mkdirSync(exploitDir, { recursive: true });
      fs.mkdirSync(validWarden, { recursive: true });
      try {
        assert.throws(
          () => validateBindPath(exploitDir, "warden"),
          BindPathSegmentError
        );

        const validated = validateBindPath(validWarden, "warden");
        const segs = validated.split(/[/\\]+/).filter(Boolean);
        assert.ok(segs.includes("warden"));
      } finally {
        fs.rmSync(exploitDir, { recursive: true, force: true });
        fs.rmSync(validWarden, { recursive: true, force: true });
      }
    });

    it("rejects when requireBindPath is set and bindPath is missing", async () => {
      const { backend } = createMockExecutionBackend();

      // Constructor rejects when requireBindPath is set but bindPath is omitted
      assert.throws(
        () =>
          new ExhumerHarness({
            runId: "run-req-bind",
            baseSha: "sha0002",
            backend,
            requireBindPath: true,
            wallClockTimeoutMs: 60000,
          }),
        BindPathRequiredError
      );

      // provisionBoxes rejects if called with settings and bindPath was omitted
      const mockRunner = async (): Promise<CommandExecutionResult> => ({ exitCode: 0 });
      const harness = new ExhumerHarness({
        runId: "run-settings-nobind",
        baseSha: "sha0002b",
        backend,
        runner: mockRunner,
        wallClockTimeoutMs: 1000,
        settings: { maxWallClockTimeoutMs: 5000 },
      });

      await assert.rejects(
        async () => {
          await harness.provisionBoxes();
        },
        BindPathRequiredError
      );
    });

    it("provisionBoxes validates bindPath segments when provisioning boxes", async () => {
      const { backend, createdSpecs } = createMockExecutionBackend();
      const bPath = "/tmp/builders/task-77";
      const wPath = "/tmp/warden/audit-77";
      fs.mkdirSync(bPath, { recursive: true });
      fs.mkdirSync(wPath, { recursive: true });
      try {
        const harness = new ExhumerHarness({
          runId: "run-valid-bind",
          baseSha: "sha0003",
          backend,
          bindPath: bPath,
          wardenBindPath: wPath,
          wallClockTimeoutMs: 60000,
        });

        const { runbox, auditbox } = await harness.provisionBoxes();
        assert.ok(runbox);
        assert.ok(auditbox);
        assert.equal(createdSpecs.length, 2);

        const runboxSpec = createdSpecs.find((s) => s.labels?.role === "runbox");
        const auditboxSpec = createdSpecs.find((s) => s.labels?.role === "auditbox");

        assert.equal(runboxSpec?.workspace?.mode, "bind");
        assert.equal(auditboxSpec?.workspace?.mode, "bind");
        if (runboxSpec?.workspace?.mode === "bind") {
          assert.ok(runboxSpec.workspace.hostPath.includes("builders"));
        }
        if (auditboxSpec?.workspace?.mode === "bind") {
          assert.ok(auditboxSpec.workspace.hostPath.includes("warden"));
        }
      } finally {
        fs.rmSync(bPath, { recursive: true, force: true });
        fs.rmSync(wPath, { recursive: true, force: true });
      }
    });
  });

  describe("Wall-clock timeout bounded by settings (L-7)", () => {
    it("rejects when wallClockTimeoutMs is missing or invalid", () => {
      assert.throws(
        () => resolveWallClockTimeout(undefined, { maxWallClockTimeoutMs: 60000 }),
        (err: unknown) => {
          assert.ok(err instanceof TimeoutRequiredError);
          assert.match((err as Error).message, /caller must provide wallClockTimeoutMs/i);
          return true;
        }
      );

      assert.throws(
        () => resolveWallClockTimeout(0, { maxWallClockTimeoutMs: 60000 }),
        TimeoutRequiredError
      );

      assert.throws(
        () => resolveWallClockTimeout(-500, { maxWallClockTimeoutMs: 60000 }),
        TimeoutRequiredError
      );

      assert.throws(
        () => resolveWallClockTimeout(NaN, { maxWallClockTimeoutMs: 60000 }),
        TimeoutRequiredError
      );

      assert.throws(
        () => resolveWallClockTimeout(Infinity, { maxWallClockTimeoutMs: 60000 }),
        TimeoutRequiredError
      );

      assert.throws(
        () => resolveWallClockTimeout(12.34, { maxWallClockTimeoutMs: 60000 }),
        TimeoutRequiredError
      );
    });

    it("rejects when settings or configured maximum is missing", () => {
      assert.throws(
        () => resolveWallClockTimeout(5000, undefined),
        (err: unknown) => {
          assert.ok(err instanceof TimeoutSettingRequiredError);
          return true;
        }
      );

      assert.throws(
        () => resolveWallClockTimeout(5000, null),
        TimeoutSettingRequiredError
      );

      assert.throws(
        () => resolveWallClockTimeout(5000, {}),
        (err: unknown) => {
          assert.ok(err instanceof TimeoutSettingRequiredError);
          assert.match((err as Error).message, /maximum timeout setting is required/i);
          return true;
        }
      );

      assert.throws(
        () => resolveWallClockTimeout(5000, { maxWallClockTimeoutMs: -100 }),
        TimeoutSettingRequiredError
      );

      assert.throws(
        () => resolveWallClockTimeout(5000, { maxWallClockTimeoutMs: "unlimited" as unknown as number }),
        TimeoutSettingRequiredError
      );
    });

    it("rejects when wallClockTimeoutMs exceeds configured maximum", () => {
      assert.throws(
        () => resolveWallClockTimeout(10000, { maxWallClockTimeoutMs: 5000 }),
        (err: unknown) => {
          assert.ok(err instanceof TimeoutExceededError);
          assert.match((err as Error).message, /exceeds configured maximum/i);
          return true;
        }
      );
    });

    it("accepts wallClockTimeoutMs within configured maximum", () => {
      const resolved = resolveWallClockTimeout(3000, { maxWallClockTimeoutMs: 5000 });
      assert.equal(resolved, 3000);

      const atLimit = resolveWallClockTimeout(5000, { maxWallClockTimeoutMs: 5000 });
      assert.equal(atLimit, 5000);
    });

    it("supports maxTimeoutMs and alias keys in settings", () => {
      const resolved = resolveWallClockTimeout(2000, { maxTimeoutMs: 4000 });
      assert.equal(resolved, 2000);
    });

    it("enforces timeout validation in ExhumerHarness constructor when settings are provided", () => {
      const mockRunner = async (): Promise<CommandExecutionResult> => ({ exitCode: 0 });

      // Missing timeout with settings provided -> rejects
      assert.throws(
        () =>
          new ExhumerHarness({
            runId: "run-timeout-missing",
            baseSha: "sha0004",
            runner: mockRunner,
            settings: { maxWallClockTimeoutMs: 5000 },
          }),
        TimeoutRequiredError
      );

      // Timeout exceeding maximum -> rejects
      assert.throws(
        () =>
          new ExhumerHarness({
            runId: "run-timeout-exceed",
            baseSha: "sha0005",
            runner: mockRunner,
            wallClockTimeoutMs: 15000,
            settings: { maxWallClockTimeoutMs: 5000 },
          }),
        TimeoutExceededError
      );

      // Valid timeout within bound -> accepted
      const harness = new ExhumerHarness({
        runId: "run-timeout-ok",
        baseSha: "sha0006",
        runner: mockRunner,
        wallClockTimeoutMs: 4000,
        settings: { maxWallClockTimeoutMs: 5000 },
      });
      assert.equal(harness.options.wallClockTimeoutMs, 4000);
    });
  });
});
