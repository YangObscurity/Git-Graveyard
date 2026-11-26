import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  decide,
  createPermissionBroker,
  isRootDir,
  validatePermissionRequest,
  MalformedRequestError,
  DuplicateOptionIdError,
  InvalidRequestError,
} from "../../lib/broker/permission-broker";

describe("Work package R3-H: Permission broker fixes (M-1, L-9, open items)", () => {
  it("a planner scope check uses the real path, so a symlink that leaves the scope is rejected", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-r3-planner-"));
    try {
      const specsDir = path.join(tmpDir, "specs");
      const outsideDir = path.join(tmpDir, "outside");
      fs.mkdirSync(specsDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const outsideFile = path.join(outsideDir, "secret.md");
      fs.writeFileSync(outsideFile, "# Secret Outside File\n", "utf8");

      // Symlink under specs/ pointing to outsideDir/secret.md
      const symlinkFile = path.join(specsDir, "escaped.md");
      fs.symlinkSync(outsideFile, symlinkFile);

      // Normal file inside specs/
      const legitFile = path.join(specsDir, "plan.md");
      fs.writeFileSync(legitFile, "# Legitimate Spec\n", "utf8");

      // 1. Target is the symlink inside specs/ that leaves the scope -> REJECTED
      const symlinkDecision = decide({
        role: "Planner",
        cwd: tmpDir,
        capability: "fs_write",
        target: symlinkFile,
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      });

      assert.equal(symlinkDecision.outcome.outcome, "selected");
      assert.equal(symlinkDecision.outcome.optionId, "opt-reject");
      assert.equal(symlinkDecision.optionKind, "reject_once");
      assert.equal(symlinkDecision.decision, "reject_once");
      assert.equal(symlinkDecision.rule, "reject_fs_write_outside_scope");

      // 2. Relative path to the symlink inside specs/ -> REJECTED
      const relSymlinkDecision = decide({
        role: "Planner",
        cwd: tmpDir,
        capability: "fs_write",
        target: "specs/escaped.md",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      });

      assert.equal(relSymlinkDecision.outcome.outcome, "selected");
      assert.equal(relSymlinkDecision.outcome.optionId, "opt-reject");
      assert.equal(relSymlinkDecision.optionKind, "reject_once");
      assert.equal(relSymlinkDecision.decision, "reject_once");
      assert.equal(relSymlinkDecision.rule, "reject_fs_write_outside_scope");

      // 3. Legitimate file directly in specs/ -> ALLOWED
      const legitDecision = decide({
        role: "Planner",
        cwd: tmpDir,
        capability: "fs_write",
        target: "specs/plan.md",
        options: [
          { optionId: "opt-allow", kind: "allow_once" },
          { optionId: "opt-reject", kind: "reject_once" },
        ],
      });

      assert.equal(legitDecision.outcome.outcome, "selected");
      assert.equal(legitDecision.outcome.optionId, "opt-allow");
      assert.equal(legitDecision.optionKind, "allow_once");
      assert.equal(legitDecision.decision, "allow_once");
      assert.equal(legitDecision.rule, "allow_fs_write_scope");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("the root path is rejected", () => {
    const cwd = "/workspace/repo";

    // 1. POSIX root '/' rejected for fs_read
    const readPosixRoot = decide({
      role: "Planner",
      cwd,
      capability: "fs_read",
      target: "/",
      options: [
        { optionId: "1", kind: "allow_once" },
        { optionId: "2", kind: "reject_once" },
      ],
    });
    assert.equal(readPosixRoot.outcome.outcome, "selected");
    assert.equal(readPosixRoot.outcome.optionId, "2");
    assert.equal(readPosixRoot.optionKind, "reject_once");
    assert.equal(readPosixRoot.decision, "reject_once");
    assert.equal(readPosixRoot.rule, "reject_fs_read_outside_workspace");

    // 2. POSIX root '/' rejected for fs_write
    const writePosixRoot = decide({
      role: "Soul-stitcher",
      cwd,
      capability: "fs_write",
      target: "/",
      options: [
        { optionId: "1", kind: "allow_once" },
        { optionId: "2", kind: "reject_once" },
      ],
    });
    assert.equal(writePosixRoot.outcome.outcome, "selected");
    assert.equal(writePosixRoot.outcome.optionId, "2");
    assert.equal(writePosixRoot.optionKind, "reject_once");
    assert.equal(writePosixRoot.decision, "reject_once");
    assert.equal(writePosixRoot.rule, "reject_fs_write_outside_scope");

    // 3. Platform parsed root rejected
    const parsedRoot = path.parse(process.cwd()).root;
    const readParsedRoot = decide({
      role: "Planner",
      cwd,
      capability: "fs_read",
      target: parsedRoot,
      options: [
        { optionId: "1", kind: "allow_once" },
        { optionId: "2", kind: "reject_once" },
      ],
    });
    assert.equal(readParsedRoot.optionKind, "reject_once");
    assert.equal(readParsedRoot.rule, "reject_fs_read_outside_workspace");

    // 4. Windows root C:\ rejected
    const readWinRoot = decide({
      role: "Planner",
      cwd,
      capability: "fs_read",
      target: "C:\\",
      options: [
        { optionId: "1", kind: "allow_once" },
        { optionId: "2", kind: "reject_once" },
      ],
    });
    assert.equal(readWinRoot.optionKind, "reject_once");
    assert.equal(readWinRoot.rule, "reject_fs_read_outside_workspace");

    const writeWinRoot = decide({
      role: "Soul-stitcher",
      cwd,
      capability: "fs_write",
      target: "C:\\",
      options: [
        { optionId: "1", kind: "allow_once" },
        { optionId: "2", kind: "reject_once" },
      ],
    });
    assert.equal(writeWinRoot.optionKind, "reject_once");
    assert.equal(writeWinRoot.rule, "reject_fs_write_outside_scope");

    // 5. isRootDir helper verification
    assert.equal(isRootDir("/"), true);
    assert.equal(isRootDir("///"), true);
    assert.equal(isRootDir("C:\\"), true);
    assert.equal(isRootDir("D:/"), true);
    assert.equal(isRootDir("/workspace/repo"), false);
    assert.equal(isRootDir("specs/task.md"), false);
    assert.equal(isRootDir(""), false);
  });

  it("a duplicate optionId is rejected", async () => {
    // 1. Pure decide() cancels and emits anomaly naming duplicate id
    const res = decide({
      role: "Planner",
      cwd: "/workspace/repo",
      capability: "fs_read",
      target: "specs/task.md",
      options: [
        { optionId: "dup-id-1", kind: "allow_once" },
        { optionId: "dup-id-1", kind: "reject_once" },
      ],
    });

    assert.equal(res.outcome.outcome, "cancelled");
    assert.equal(res.selectedOption, null);
    assert.equal(res.selectedOptionId, null);
    assert.equal(res.cancelTurn, true);
    assert.equal(res.anomaly, true);
    assert.equal(res.event.kind, "permission.anomaly");
    assert.ok(
      res.event.data.reason.includes("dup-id-1") ||
      (res.event.data as any).duplicateOptionId === "dup-id-1"
    );

    // 2. validatePermissionRequest() rejects duplicate optionId with a named error
    assert.throws(
      () => {
        validatePermissionRequest({
          sessionId: "sess-r3-1",
          runId: "run-r3-1",
          options: [
            { optionId: "shared-opt", kind: "allow_once" },
            { optionId: "shared-opt", kind: "reject_once" },
          ],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.ok(
          err instanceof DuplicateOptionIdError ||
          (err as Error).name === "DuplicateOptionIdError" ||
          (err as Error).name === "MalformedRequestError"
        );
        return true;
      }
    );

    // 3. PermissionBrokerAdapter rejects duplicate optionIds
    const broker = createPermissionBroker({
      watchdogLimitMs: 5000,
      role: "Planner",
      cwd: "/workspace/repo",
    });

    const brokerRes = await broker.handleRequestPermission({
      sessionId: "sess-r3-1",
      runId: "run-r3-1",
      capability: "fs_read",
      target: "specs/task.md",
      options: [
        { optionId: "dup-99", kind: "allow_once" },
        { optionId: "dup-99", kind: "reject_once" },
      ],
    });

    assert.equal(brokerRes.outcome.outcome, "cancelled");
  });

  it("a malformed request is rejected", async () => {
    const validOption = { optionId: "opt-1", kind: "allow_once" };

    // 1. Missing session id
    assert.throws(
      () => {
        validatePermissionRequest({
          runId: "run-r3-1",
          options: [validOption],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        assert.match((err as Error).message, /sessionId/i);
        return true;
      }
    );

    // 2. Missing run id
    assert.throws(
      () => {
        validatePermissionRequest({
          sessionId: "sess-r3-1",
          options: [validOption],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        assert.match((err as Error).message, /runId/i);
        return true;
      }
    );

    // 3. Missing options array
    assert.throws(
      () => {
        validatePermissionRequest({
          sessionId: "sess-r3-1",
          runId: "run-r3-1",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        assert.match((err as Error).message, /options/i);
        return true;
      }
    );

    // 4. options is not an array
    assert.throws(
      () => {
        validatePermissionRequest({
          sessionId: "sess-r3-1",
          runId: "run-r3-1",
          options: "not-an-array" as any,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        return true;
      }
    );

    // 5. Option missing optionId
    assert.throws(
      () => {
        validatePermissionRequest({
          sessionId: "sess-r3-1",
          runId: "run-r3-1",
          options: [{ kind: "allow_once" } as any],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        assert.match((err as Error).message, /optionId/i);
        return true;
      }
    );

    // 6. Option missing kind
    assert.throws(
      () => {
        validatePermissionRequest({
          sessionId: "sess-r3-1",
          runId: "run-r3-1",
          options: [{ optionId: "opt-1" } as any],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        assert.match((err as Error).message, /kind/i);
        return true;
      }
    );

    // 7. Option with empty kind string
    assert.throws(
      () => {
        validatePermissionRequest({
          sessionId: "sess-r3-1",
          runId: "run-r3-1",
          options: [{ optionId: "opt-1", kind: "" }],
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        assert.equal((err as Error).name, "MalformedRequestError");
        return true;
      }
    );

    // 8. Non-object request
    assert.throws(
      () => {
        validatePermissionRequest(null);
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        return true;
      }
    );

    // 9. Broker instance validateRequest method
    const broker = createPermissionBroker({
      watchdogLimitMs: 5000,
      role: "Planner",
      cwd: "/workspace/repo",
    });

    assert.throws(
      () => {
        broker.validateRequest({ sessionId: "only-sess" });
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        return true;
      }
    );

    // 10. Broker handleRequestPermission with validation flag rejects malformed request
    await assert.rejects(
      async () => {
        await broker.handleRequestPermission(
          { sessionId: "only-sess" } as any,
          { validate: true }
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedRequestError);
        return true;
      }
    );
  });

  it("allow_always is never selected", () => {
    const cwd = "/workspace/repo";

    // 1. Only persistent options offered -> cancelled, never selects allow_always
    const resOnlyPersistent = decide({
      role: "Soul-stitcher",
      cwd,
      capability: "fs_write",
      target: "tasks.txt",
      options: [
        { optionId: "opt-always", kind: "allow_always" },
      ],
    });

    assert.equal(resOnlyPersistent.outcome.outcome, "cancelled");
    assert.equal(resOnlyPersistent.selectedOption, null);
    assert.equal(resOnlyPersistent.selectedOptionId, null);
    assert.equal(resOnlyPersistent.cancelTurn, true);
    assert.notEqual(resOnlyPersistent.optionKind, "allow_always");

    // 2. Both allow_always and reject_always offered -> cancelled
    const resBothPersistent = decide({
      role: "Planner",
      cwd,
      capability: "fs_write",
      target: "specs/task.md",
      options: [
        { optionId: "1", kind: "allow_always" },
        { optionId: "2", kind: "reject_always" },
      ],
    });

    assert.equal(resBothPersistent.outcome.outcome, "cancelled");
    assert.equal(resBothPersistent.cancelTurn, true);
    assert.equal(resBothPersistent.selectedOption, null);
    assert.notEqual(resBothPersistent.optionKind, "allow_always");
    assert.notEqual(resBothPersistent.optionKind, "reject_always");

    // 3. allow_always offered with reject_once for an allowed action -> cancelled
    // (cannot select allow_always, and neededKind is allow_once which is not offered)
    const resAllowAlwaysWithRejectOnce = decide({
      role: "Soul-stitcher",
      cwd,
      capability: "fs_write",
      target: "tasks.txt",
      options: [
        { optionId: "1", kind: "allow_always" },
        { optionId: "2", kind: "reject_once" },
      ],
    });

    assert.equal(resAllowAlwaysWithRejectOnce.outcome.outcome, "cancelled");
    assert.equal(resAllowAlwaysWithRejectOnce.cancelTurn, true);
    assert.equal(resAllowAlwaysWithRejectOnce.selectedOption, null);
    assert.notEqual(resAllowAlwaysWithRejectOnce.optionKind, "allow_always");

    // 4. allow_always offered with allow_once -> selects allow_once, never allow_always
    // Selection is made by index in the array
    const resWithAllowOnce = decide({
      role: "Soul-stitcher",
      cwd,
      capability: "fs_write",
      target: "tasks.txt",
      options: [
        { optionId: "opt-always", kind: "allow_always" },
        { optionId: "opt-once", kind: "allow_once" },
      ],
    });

    assert.equal(resWithAllowOnce.outcome.outcome, "selected");
    assert.equal(resWithAllowOnce.outcome.optionId, "opt-once");
    assert.equal(resWithAllowOnce.selectedOption?.kind, "allow_once");
    assert.notEqual(resWithAllowOnce.selectedOption?.kind, "allow_always");
    assert.equal(resWithAllowOnce.optionKind, "allow_once");
  });
});
