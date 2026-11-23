/**
 * FIX-PR1: every gateway event reaches the EventStore exactly once.
 *
 * Before the fix, RuntimeHost gave McpGateway both its EventStore and an
 * onEmitEvent callback that appends to that same store. ApprovalManager and
 * execution-tools wrote to both, so each approval and command event was stored
 * twice (recorded run live-gulp-plumber-t40 shows the duplicates).
 */
import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EventStore } from "../../lib/events/event-store";
import type { EventEnvelope } from "../../lib/events/event-store";
import { LogStore } from "../../lib/events/log-store";
import { RunStore } from "../../lib/runs/run-store";
import { RuntimeHost } from "../../lib/runtime/runtime-host";

const RUN_ID = "run-single-write";

const createdHosts: RuntimeHost[] = [];
const tempDirs: string[] = [];

function createHost(): { host: RuntimeHost; eventStore: EventStore; delivered: EventEnvelope[] } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-single-write-"));
  tempDirs.push(tmp);
  const eventStore = new EventStore({ path: ":memory:" });
  const delivered: EventEnvelope[] = [];
  const host = new RuntimeHost({
    runStore: new RunStore({ path: ":memory:" }),
    eventStore,
    logStore: new LogStore({ dir: path.join(tmp, "logs") }),
    backend: {} as never,
    skipReconcile: true,
    onEvent: (event) => {
      delivered.push(event);
    },
  });
  createdHosts.push(host);
  return { host, eventStore, delivered };
}

afterEach(async () => {
  for (const host of createdHosts.splice(0)) {
    await host.shutdown().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("RuntimeHost: gateway events are stored once", () => {
  it("stores and delivers one approval.requested per approval", async () => {
    const { host, eventStore, delivered } = createHost();

    await host.gateway.approvalManager.requestApproval({
      runId: RUN_ID,
      skeletonId: "skel-soul",
      argv: ["npm", "install"],
      cwd: "/workspace/repo",
      ttlMs: 30000,
      reason: "install dependencies",
    });

    const stored = eventStore.getEvents(RUN_ID, { kind: "approval.requested" });
    assert.equal(stored.length, 1, "approval.requested must be stored once");
    assert.equal(
      delivered.filter((event) => event.kind === "approval.requested").length,
      1,
      "live subscribers must still receive the event"
    );
  });

  it("stores one command.refused per refused sandbox_exec", async () => {
    const { host, eventStore, delivered } = createHost();
    const skeleton = host.gateway.registerSkeleton({
      skeletonId: "skel-exhumer",
      role: "Exhumer",
      worktreeRoot: "/workspace/repo",
      runId: RUN_ID,
    });

    const result = (await host.gateway.handleToolCall(skeleton.bearerToken, "sandbox_exec", {
      argv: ["sudo", "apt", "install", "gcc"],
    })) as { status: string };

    assert.equal(result.status, "blocked");
    const stored = eventStore.getEvents(RUN_ID, { kind: "command.refused" });
    assert.equal(stored.length, 1, "command.refused must be stored once");
    assert.equal(
      delivered.filter((event) => event.kind === "command.refused").length,
      1,
      "live subscribers must still receive the event"
    );
  });
});
