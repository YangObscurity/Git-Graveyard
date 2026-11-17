import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import {
  EventStore,
  getDefaultEventStore,
  resetDefaultEventStore,
} from "../../lib/events/event-store";
import {
  LogStore,
  getDefaultLogStore,
  resetDefaultLogStore,
} from "../../lib/events/log-store";
import {
  RunStore,
  getDefaultRunStore,
  resetDefaultRunStore,
} from "../../lib/runs/run-store";
import {
  RuntimeHost,
  createRuntimeHost,
  getRuntimeHost,
  resetRuntimeHost,
} from "../../lib/runtime/runtime-host";
import { getRequiredBrokerSettings } from "../supervisor/fixtures";

function requestHttp(
  url: string,
  bearerToken: string,
  body: unknown
): Promise<{ statusCode: number; data: any }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const postData = JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
          Authorization: `Bearer ${bearerToken}`,
          Connection: "close",
        },
      },
      (res) => {
        let respData = "";
        res.on("data", (chunk) => {
          respData += chunk.toString("utf-8");
        });
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode ?? 0,
              data: respData ? JSON.parse(respData) : {},
            });
          } catch {
            resolve({
              statusCode: res.statusCode ?? 0,
              data: respData,
            });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

describe("RuntimeHost and Shared Singletons", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(async () => {
    await resetRuntimeHost();
    resetDefaultEventStore();
    resetDefaultRunStore();
    resetDefaultLogStore();
  });

  afterEach(async () => {
    await resetRuntimeHost({ closeStores: true });
    resetDefaultEventStore();
    resetDefaultRunStore();
    resetDefaultLogStore();

    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  it("1. shared singletons: getDefaultEventStore & getDefaultLogStore", () => {
    const eventStore = getDefaultEventStore({ path: ":memory:" });
    assert.ok(eventStore instanceof EventStore);
    const g = globalThis as any;
    assert.equal(g.__sharedEventStore, eventStore);
    assert.equal(getDefaultEventStore(), eventStore);

    resetDefaultEventStore();
    assert.equal(g.__sharedEventStore, undefined);

    const logStore = getDefaultLogStore({ inMemory: true });
    assert.ok(logStore instanceof LogStore);
    assert.equal(g.__sharedLogStore, logStore);
    assert.equal(getDefaultLogStore(), logStore);

    resetDefaultLogStore();
    assert.equal(g.__sharedLogStore, undefined);
  });

  it("2. getDefaultEventStore default path resolution and env fallback", () => {
    const customTmp = makeTmpDir("event-store-env-");
    const customDbPath = path.join(customTmp, "custom-events.db");
    const origEnv = process.env.EVENT_STORE_PATH;
    try {
      process.env.EVENT_STORE_PATH = customDbPath;
      const store = getDefaultEventStore();
      assert.ok(store instanceof EventStore);
      assert.equal(fs.existsSync(customDbPath), true);
    } finally {
      if (origEnv !== undefined) {
        process.env.EVENT_STORE_PATH = origEnv;
      } else {
        delete process.env.EVENT_STORE_PATH;
      }
      resetDefaultEventStore();
    }
  });

  it("3. getDefaultLogStore default dir resolution and env fallback", () => {
    const customTmp = makeTmpDir("log-store-env-");
    const customLogDir = path.join(customTmp, "custom-logs");
    const origEnv = process.env.LOG_STORE_DIR;
    try {
      process.env.LOG_STORE_DIR = customLogDir;
      const store = getDefaultLogStore();
      assert.ok(store instanceof LogStore);
      assert.equal(fs.existsSync(customLogDir), true);
      assert.equal(store.dir, customLogDir);
    } finally {
      if (origEnv !== undefined) {
        process.env.LOG_STORE_DIR = origEnv;
      } else {
        delete process.env.LOG_STORE_DIR;
      }
      resetDefaultLogStore();
    }
  });

  it("4. standalone new EventStore and new LogStore behaviors are preserved", () => {
    const standaloneEventStore = new EventStore();
    assert.ok(standaloneEventStore instanceof EventStore);
    standaloneEventStore.close();

    const standaloneLogStore = new LogStore({ inMemory: true });
    assert.ok(standaloneLogStore instanceof LogStore);
    assert.equal(standaloneLogStore.inMemory, true);
  });

  it("5. RuntimeHost construction registers globals and backend availability adapter", async () => {
    const eventDb = makeTmpDir("rh-event-");
    const runDb = makeTmpDir("rh-run-");
    const eventStore = new EventStore(path.join(eventDb, "events.db"));
    const runStore = new RunStore(path.join(runDb, "runs.db"));
    const logStore = new LogStore({ inMemory: true });

    const host = createRuntimeHost({
      eventStore,
      runStore,
      logStore,
      skipReconcile: false,
    });

    try {
      const g = globalThis as any;
      assert.equal(g.__sharedRunStore, runStore);
      assert.equal(g.__sharedEventStore, eventStore);
      assert.ok(g.__backend);
      assert.equal(g.__backend.isAvailable(), true);
      assert.equal(g.__backend.isHealthy(), true);
      assert.equal(g.__backend.isPaused(), false);
      assert.equal(g.__backend.getReason(), "OK");

      host.pause();
      assert.equal(g.__backend.isPaused(), true);
      assert.equal(g.__backend.isAvailable(), false);
      assert.equal(g.__backend.getReason(), "RuntimeHost paused");

      host.resume();
      assert.equal(g.__backend.isPaused(), false);
      assert.equal(g.__backend.isAvailable(), true);
      assert.equal(g.__backend.getReason(), "OK");

      assert.ok(host.bootReconcileResult !== undefined);
    } finally {
      await host.shutdown({ closeStores: true });
    }
  });

  it("6. emitEvent persists redacted events and invokes subscribers", async () => {
    const eventStore = new EventStore(":memory:");
    const runStore = new RunStore(":memory:");
    const logStore = new LogStore({ inMemory: true });

    const receivedEvents: any[] = [];
    const host = createRuntimeHost({
      eventStore,
      runStore,
      logStore,
      skipReconcile: true,
      onEvent: (evt) => {
        receivedEvents.push(evt);
      },
    });

    try {
      const envelope = host.emitEvent({
        runId: "run-test-1",
        kind: "task.state",
        actor: "Planner",
        data: {
          taskId: "task-01",
          state: "ready",
          token: "ghp_ABC1234567890abcdefghijklmnopqrstuvwxyz",
          refs: ["ref-1"],
        },
      });

      assert.equal(envelope.runId, "run-test-1");
      assert.equal(envelope.kind, "task.state");
      assert.equal(envelope.seq, 1);
      assert.equal(receivedEvents.length, 1);
      assert.equal(receivedEvents[0].seq, 1);

      const stored = eventStore.getEvent("run-test-1", 1);
      assert.ok(stored);
      assert.equal(stored.kind, "task.state");
      const storedData = stored.data as Record<string, unknown>;
      assert.notEqual(
        storedData.token,
        "ghp_ABC1234567890abcdefghijklmnopqrstuvwxyz"
      );
    } finally {
      await host.shutdown({ closeStores: true });
    }
  });

  it("7. McpGateway + createMcpGatewayServer HTTP round-trip on 127.0.0.1:0", async () => {
    const eventStore = new EventStore(":memory:");
    const runStore = new RunStore(":memory:");
    const logStore = new LogStore({ inMemory: true });
    const tmpBase = makeTmpDir("gw-http-wt-");

    const host = createRuntimeHost({
      eventStore,
      runStore,
      logStore,
      skipReconcile: true,
    });

    try {
      const serverInfo = await host.startGatewayServer(0, "127.0.0.1");
      assert.ok(serverInfo.port > 0);
      assert.equal(serverInfo.host, "127.0.0.1");
      assert.ok(serverInfo.url.startsWith("http://127.0.0.1:"));

      host.gateway.registerSkeleton({
        skeletonId: "skel-http-test",
        role: "Planner",
        worktreeRoot: tmpBase,
        bearerToken: "test-token-roundtrip",
        runId: "run-http-test",
      });

      const res = await requestHttp(serverInfo.url, "test-token-roundtrip", {
        tool: "report_task_result",
        arguments: {
          runId: "run-http-test",
          taskId: "task-01",
          status: "completed",
          summary: "Task done successfully",
        },
      });

      assert.equal(res.statusCode, 200);
      assert.ok(res.data);
      assert.equal(res.data.status, "completed");
    } finally {
      await host.shutdown({ closeStores: true });
    }
  });

  it("8. SkeletonSupervisor creation wired to gateway + EventStore forwarding", async () => {
    const eventStore = new EventStore(":memory:");
    const runStore = new RunStore(":memory:");
    const logStore = new LogStore({ inMemory: true });
    const tmpBase = makeTmpDir("sup-wired-");
    const worktreeDir = path.join(tmpBase, "wt");
    const quarantineDir = path.join(tmpBase, "quarantine");
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(quarantineDir, { recursive: true });

    const host = createRuntimeHost({
      eventStore,
      runStore,
      logStore,
      skipReconcile: true,
    });

    try {
      const supervisor = host.createSupervisor({
        runId: "run-sup-wired",
        skeletonId: "skel-sup-wired",
        role: "Planner",
        cwd: worktreeDir,
        quarantineDir,
        allowedRoot: tmpBase,
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 5000,
        brokerOptions: getRequiredBrokerSettings(),
      } as any);

      assert.ok(supervisor);

      (supervisor as any).failSkeleton(
        "test_failure",
        "Intentional test failure"
      );

      const events = eventStore.getEvents("run-sup-wired");
      assert.ok(events.length >= 1);
      const failedEvt = events.find((e) => e.kind === "skeleton.failed");
      assert.ok(failedEvt);
      assert.equal(failedEvt.runId, "run-sup-wired");
      assert.equal(failedEvt.actor, "SkeletonSupervisor");
    } finally {
      await host.shutdown({ closeStores: true });
    }
  });

  it("9. fatal gateway event triggers BOTH supervisor quarantine AND RuntimeHost fatal run handler + RunStore/EventStore update", async () => {
    const eventStore = new EventStore(":memory:");
    const runStore = new RunStore(":memory:");
    const logStore = new LogStore({ inMemory: true });
    const tmpBase = makeTmpDir("fatal-wire-");
    const worktreeDir = path.join(tmpBase, "wt");
    const quarantineDir = path.join(tmpBase, "quarantine");
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(quarantineDir, { recursive: true });

    const host = createRuntimeHost({
      eventStore,
      runStore,
      logStore,
      skipReconcile: true,
    });

    try {
      const runId = "run-fatal-test";
      const skeletonId = "skel-fatal-test";

      runStore.createRun({
        runId,
        url: "https://github.com/example/repo",
        sha: "abc1234",
        phase: "legion",
      });

      const supervisor = host.createSupervisor({
        runId,
        skeletonId,
        role: "Planner",
        cwd: worktreeDir,
        quarantineDir,
        allowedRoot: tmpBase,
        watchdogLimitMs: 5000,
        cancelGracePeriodMs: 5000,
        brokerOptions: getRequiredBrokerSettings(),
      } as any);

      assert.ok(supervisor);

      let fatalHandlerInvoked = false;
      let receivedFatalPayload: any = null;

      host.registerFatalHandler(runId, (payload) => {
        fatalHandlerInvoked = true;
        receivedFatalPayload = payload;
      });

      const fatalResult = {
        status: "fatal",
        fatal: true,
        quarantine: true,
        reason: "secret_leaked_in_sandbox",
        code: "FATAL_SECRET",
      };

      host.gateway.emit("fatal", {
        skeletonId,
        runId,
        result: fatalResult,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(
        (supervisor as any).worktreeQuarantined,
        true,
        "Supervisor worktree must be quarantined"
      );
      assert.equal(
        (supervisor as any).state,
        "terminated",
        "Supervisor state must be terminated"
      );
      const quarantineFiles = fs.readdirSync(quarantineDir);
      assert.ok(
        quarantineFiles.length > 0,
        "Quarantine file must be created under quarantineDir"
      );

      assert.equal(
        fatalHandlerInvoked,
        true,
        "RuntimeHost fatal run handler must be invoked"
      );
      assert.equal(receivedFatalPayload?.runId, runId);
      assert.equal(receivedFatalPayload?.skeletonId, skeletonId);

      const runRecord = runStore.getRun(runId);
      assert.ok(runRecord);
      assert.equal(
        runRecord.outcome,
        "error",
        "RunStore record outcome must be updated to error"
      );
      assert.equal(
        runRecord.phase,
        "done",
        "RunStore record phase must be updated to done"
      );

      const events = eventStore.getEvents(runId);
      const quarantineEvents = events.filter(
        (e) => (e.data as any).quarantine === true
      );
      assert.ok(
        quarantineEvents.length >= 1,
        "EventStore must contain quarantined event"
      );
    } finally {
      await host.shutdown({ closeStores: true });
    }
  });

  it("10. getRuntimeHost singleton and resetRuntimeHost", async () => {
    const host1 = getRuntimeHost({
      skipReconcile: true,
    });
    const host2 = getRuntimeHost();
    assert.equal(host1, host2);

    await resetRuntimeHost({ closeStores: true });
    const host3 = getRuntimeHost({
      skipReconcile: true,
    });
    assert.notEqual(host1, host3);
    await resetRuntimeHost({ closeStores: true });
  });
});
