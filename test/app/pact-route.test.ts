import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RunStore } from "@/lib/runs/run-store";
import { EventStore } from "@/lib/events/event-store";
import { GET, POST, PUT, PATCH } from "@/app/api/runs/[runId]/pact/route";
import type { PactTask } from "@/lib/pact/pact-parser";
import { renderPact } from "@/lib/pact/pact-renderer";

function createTestDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function createTestHarness(options?: { withInviteCode?: string }) {
  const db = createTestDb();
  const runStore = new RunStore(db);
  const eventStore = new EventStore(db);

  let inviteCodeHash: string | null = null;
  if (options?.withInviteCode) {
    const invite = runStore.createInviteCode({
      code: options.withInviteCode,
      allowedRunCount: 5,
    });
    inviteCodeHash = invite.codeHash;
  }

  return {
    db,
    runStore,
    eventStore,
    inviteCodeHash,
    createRun: (
      runId: string,
      phase:
        | "queued"
        | "exhume"
        | "plan"
        | "pact_review"
        | "legion"
        | "final_check"
        | "report"
        | "done" = "pact_review",
      caps?: Record<string, unknown>
    ) => {
      return runStore.createRun({
        runId,
        url: "https://test.example/owner/repo",
        sha: "1234567890abcdef1234567890abcdef12345678",
        phase,
        outcome: null,
        inviteCodeHash,
        caps: caps ?? { maxMinutes: 120, maxParallel: 4 },
      });
    },
  };
}

function createSampleTasks(): PactTask[] {
  return [
    {
      id: "T1",
      title: "Update dependencies in package.json",
      role: "bonesetter",
      dependencies: [],
      depends: [],
      dependsOn: [],
      files: ["package.json"],
      filesInScope: ["package.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 1,
    },
    {
      id: "T2",
      title: "Migrate request calls",
      role: "soul-stitcher",
      dependencies: ["T1"],
      depends: ["T1"],
      dependsOn: ["T1"],
      files: ["lib/request.js"],
      filesInScope: ["lib/request.js"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      rules: ["M2"],
      ruleIds: ["M2"],
      line: 8,
    },
    {
      id: "T3",
      title: "Warden final check verification",
      role: "bonesetter",
      dependencies: ["T2"],
      depends: ["T2"],
      dependsOn: ["T2"],
      files: ["package.json"],
      filesInScope: ["package.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 15,
    },
    {
      id: "T4",
      title: "Scribe report generation",
      role: "soul-stitcher",
      dependencies: ["T3"],
      depends: ["T3"],
      dependsOn: ["T3"],
      files: ["report/evidence.json"],
      filesInScope: ["report/evidence.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 22,
    },
    {
      id: "T5",
      title: "Grimoire gate verification",
      role: "bonesetter",
      dependencies: ["T4"],
      depends: ["T4"],
      dependsOn: ["T4"],
      files: ["package.json"],
      filesInScope: ["package.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 29,
    },
  ];
}

describe("Pact API Routes: GET /api/runs/[runId]/pact", () => {
  it("returns 400 when runId is missing", async () => {
    const req = new Request("http://test/api/runs//pact");
    const res = await GET(req, { params: { runId: "" } });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, "MISSING_RUN_ID");
  });

  it("returns 404 when run does not exist and has no events", async () => {
    const harness = createTestHarness();
    const req = new Request("http://test/api/runs/nonexistent-run/pact");
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await GET(req, { params: { runId: "nonexistent-run" } });
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, "RUN_NOT_FOUND");
  });

  it("returns status drafting when run exists in plan phase before drafting", async () => {
    const harness = createTestHarness();
    harness.createRun("run-drafting", "plan");

    const req = new Request("http://test/api/runs/run-drafting/pact");
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await GET(req, { params: { runId: "run-drafting" } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.status, "drafting");
    assert.equal(data.phase, "plan");
    assert.equal(data.pact, null);
    assert.equal(data.pactVersion, 0);
    assert.deepEqual(data.tasks, []);
    assert.equal(data.isApproved, false);
    assert.ok(Array.isArray(data.nonRemovableRequirements));
  });

  it("returns latest pact when drafted event is present", async () => {
    const harness = createTestHarness();
    harness.createRun("run-1", "pact_review");
    const tasks = createSampleTasks();

    harness.eventStore.append({
      runId: "run-1",
      kind: "pact.drafted",
      actor: "necromancer",
      data: {
        pactVersion: 1,
        tasks,
        markdown: renderPact(tasks),
        refs: [],
      },
    });

    const req = new Request("http://test/api/runs/run-1/pact");
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await GET(req, { params: { runId: "run-1" } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.runId, "run-1");
    assert.equal(data.pactVersion, 1);
    assert.equal(data.tasks.length, 5);
    assert.equal(data.isApproved, false);
    assert.ok(data.markdown.includes("T1. Update dependencies"));
    assert.ok(data.budgetTermsNote);
  });

  it("returns historical version when version parameter is passed", async () => {
    const harness = createTestHarness();
    harness.createRun("run-hist", "pact_review");
    const tasks = createSampleTasks();

    harness.eventStore.append({
      runId: "run-hist",
      kind: "pact.drafted",
      actor: "necromancer",
      data: {
        pactVersion: 1,
        tasks: [tasks[0]],
        markdown: renderPact([tasks[0]]),
        refs: [],
      },
    });

    harness.eventStore.append({
      runId: "run-hist",
      kind: "pact.edited",
      actor: "user",
      data: {
        pactVersion: 2,
        tasks,
        markdown: renderPact(tasks),
        refs: [],
      },
    });

    const reqV1 = new Request("http://test/api/runs/run-hist/pact?version=1");
    (reqV1 as any).runStore = harness.runStore;
    (reqV1 as any).eventStore = harness.eventStore;
    const resV1 = await GET(reqV1, { params: { runId: "run-hist" } });
    assert.equal(resV1.status, 200);
    const dataV1 = await resV1.json();
    assert.equal(dataV1.pactVersion, 1);
    assert.equal(dataV1.tasks.length, 1);

    const reqV2 = new Request("http://test/api/runs/run-hist/pact?version=2");
    (reqV2 as any).runStore = harness.runStore;
    (reqV2 as any).eventStore = harness.eventStore;
    const resV2 = await GET(reqV2, { params: { runId: "run-hist" } });
    assert.equal(resV2.status, 200);
    const dataV2 = await resV2.json();
    assert.equal(dataV2.pactVersion, 2);
    assert.equal(dataV2.tasks.length, 5);

    const reqV99 = new Request("http://test/api/runs/run-hist/pact?version=99");
    (reqV99 as any).runStore = harness.runStore;
    (reqV99 as any).eventStore = harness.eventStore;
    const resV99 = await GET(reqV99, { params: { runId: "run-hist" } });
    assert.equal(resV99.status, 404);
    const dataV99 = await resV99.json();
    assert.equal(dataV99.code, "VERSION_NOT_FOUND");
  });
});

describe("Pact API Routes: POST Authentication & Permissions", () => {
  it("rejects mutating request when invite code is required but missing", async () => {
    const harness = createTestHarness({ withInviteCode: "valid-secret-code" });
    harness.createRun("run-auth", "pact_review");

    const req = new Request("http://test/api/runs/run-auth/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", tasks: createSampleTasks() }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-auth" } });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, "UNAUTHORIZED");
  });

  it("rejects mutating request when invite code is incorrect", async () => {
    const harness = createTestHarness({ withInviteCode: "valid-secret-code" });
    harness.createRun("run-auth", "pact_review");

    const req = new Request("http://test/api/runs/run-auth/pact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-invite-code": "wrong-code",
      },
      body: JSON.stringify({ action: "edit", tasks: createSampleTasks() }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-auth" } });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, "UNAUTHORIZED");
  });

  it("allows mutating request with matching invite code", async () => {
    const harness = createTestHarness({ withInviteCode: "valid-secret-code" });
    harness.createRun("run-auth", "pact_review");
    const tasks = createSampleTasks();

    harness.eventStore.append({
      runId: "run-auth",
      kind: "pact.drafted",
      actor: "necromancer",
      data: { pactVersion: 1, tasks, refs: [] },
    });

    const req = new Request("http://test/api/runs/run-auth/pact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-invite-code": "valid-secret-code",
      },
      body: JSON.stringify({ action: "edit", tasks }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-auth" } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.pactVersion, 2);
  });

  it("rejects spoofed x-admin header and allows verified ADMIN_TOKEN override", async () => {
    const prevAdminToken = process.env.ADMIN_TOKEN;
    const prevAdminKey = process.env.ADMIN_KEY;
    try {
      process.env.ADMIN_TOKEN = "pact-route-admin-secret";
      delete process.env.ADMIN_KEY;

      const harness = createTestHarness({ withInviteCode: "valid-secret-code" });
      harness.createRun("run-admin", "pact_review");

      const spoofReq = new Request("http://test/api/runs/run-admin/pact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin": "true",
        },
        body: JSON.stringify({ action: "stop" }),
      });
      (spoofReq as any).runStore = harness.runStore;
      (spoofReq as any).eventStore = harness.eventStore;

      const spoofRes = await POST(spoofReq, { params: { runId: "run-admin" } });
      assert.equal(spoofRes.status, 401);

      const req = new Request("http://test/api/runs/run-admin/pact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": "pact-route-admin-secret",
        },
        body: JSON.stringify({ action: "stop" }),
      });
      (req as any).runStore = harness.runStore;
      (req as any).eventStore = harness.eventStore;

      const res = await POST(req, { params: { runId: "run-admin" } });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.status, "stopped");
    } finally {
      if (prevAdminToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevAdminToken;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }
  });
});

describe("Pact API Routes: POST Phase Constraints & Malformed Input", () => {
  it("rejects malformed JSON", async () => {
    const harness = createTestHarness();
    harness.createRun("run-malformed", "pact_review");

    const req = new Request("http://test/api/runs/run-malformed/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json ...",
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-malformed" } });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, "BAD_JSON");
  });

  it("rejects edit or approve when run is in queued phase", async () => {
    const harness = createTestHarness();
    harness.createRun("run-queued", "queued");

    const req = new Request("http://test/api/runs/run-queued/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", tasks: createSampleTasks() }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-queued" } });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.code, "INVALID_RUN_PHASE");
  });

  it("rejects modification when run is already done", async () => {
    const harness = createTestHarness();
    harness.createRun("run-done", "done");

    const req = new Request("http://test/api/runs/run-done/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", tasks: createSampleTasks() }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-done" } });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.code, "RUN_COMPLETED");
  });
});

describe("Pact API Routes: POST action=edit (Requirements 13.2, 13.5, 36.14)", () => {
  it("rejects edit that removes non-removable requirements (Requirement 13.5)", async () => {
    const harness = createTestHarness();
    harness.createRun("run-edit-lock", "pact_review");
    const originalTasks = createSampleTasks();

    harness.eventStore.append({
      runId: "run-edit-lock",
      kind: "pact.drafted",
      actor: "necromancer",
      data: { pactVersion: 1, tasks: originalTasks, refs: [] },
    });

    // Remove Warden final check (T3)
    const editedTasks = originalTasks.filter((t) => t.id !== "T3");

    const req = new Request("http://test/api/runs/run-edit-lock/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", tasks: editedTasks }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-edit-lock" } });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, "VALIDATION_FAILED");
    assert.ok(data.errors.some((e: any) => e.code === "NON_REMOVABLE_REQUIREMENT"));
  });

  it("rejects edit that introduces dependency cycles (Requirement 36.9)", async () => {
    const harness = createTestHarness();
    harness.createRun("run-cycle", "pact_review");
    const tasks = createSampleTasks();

    // Create cycle T1 -> T2 -> T1
    tasks[0].dependencies = ["T2"];
    tasks[1].dependencies = ["T1"];

    const req = new Request("http://test/api/runs/run-cycle/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", tasks }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-cycle" } });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.ok(data.errors.some((e: any) => e.code === "DEPENDENCY_CYCLE"));
  });

  it("rejects edit that has blocked commands under CommandPolicy", async () => {
    const harness = createTestHarness();
    harness.createRun("run-blocked-cmd", "pact_review");
    const tasks = createSampleTasks();
    tasks[0].acceptanceCommand = "sudo rm -rf /";
    tasks[0].accept = "sudo rm -rf /";

    const req = new Request("http://test/api/runs/run-blocked-cmd/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", tasks }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-blocked-cmd" } });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.errors.some((e: any) => e.code === "BLOCKED_COMMAND"));
  });

  it("processes valid task edit, increments pactVersion, and emits pact.edited", async () => {
    const harness = createTestHarness();
    harness.createRun("run-edit-ok", "plan");
    const tasks = createSampleTasks();

    harness.eventStore.append({
      runId: "run-edit-ok",
      kind: "pact.drafted",
      actor: "necromancer",
      data: { pactVersion: 1, tasks, refs: [] },
    });

    const modifiedTasks = [...tasks];
    modifiedTasks[0] = {
      ...modifiedTasks[0],
      title: "Update dependencies and freeze npm lock file",
    };

    const req = new Request("http://test/api/runs/run-edit-ok/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", tasks: modifiedTasks }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-edit-ok" } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.pactVersion, 2);
    assert.deepEqual(data.diff.modified, ["T1"]);

    // Verify run phase transitioned to pact_review
    const updatedRun = harness.runStore.getRun("run-edit-ok");
    assert.equal(updatedRun?.phase, "pact_review");

    // Verify pact.edited event was recorded in eventStore
    const editedEvents = harness.eventStore.getEvents("run-edit-ok", {
      kind: "pact.edited",
    });
    assert.equal(editedEvents.length, 1);
    assert.equal(editedEvents[0].data.pactVersion, 2);

    // Verify run.clock paused event was recorded
    const clockEvents = harness.eventStore.getEvents("run-edit-ok", {
      kind: "run.clock",
    });
    assert.ok(clockEvents.some((e) => (e.data as any).action === "pause"));
  });

  it("supports edit via raw Markdown string", async () => {
    const harness = createTestHarness();
    harness.createRun("run-md", "pact_review");
    const tasks = createSampleTasks();
    const markdown = renderPact(tasks);

    const req = new Request("http://test/api/runs/run-md/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", markdown }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-md" } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.pactVersion, 1);
    assert.equal(data.tasks.length, 5);
  });
});

describe("Pact API Routes: POST action=approve (Requirements 13.4, 13.8, 36.7)", () => {
  it("rejects approval if approvedTaskIds is empty or budget is missing", async () => {
    const harness = createTestHarness();
    harness.createRun("run-approve-bad", "pact_review");

    const reqNoBudget = new Request("http://test/api/runs/run-approve-bad/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", approvedTaskIds: ["T1"] }),
    });
    (reqNoBudget as any).runStore = harness.runStore;
    (reqNoBudget as any).eventStore = harness.eventStore;

    const res1 = await POST(reqNoBudget, { params: { runId: "run-approve-bad" } });
    assert.equal(res1.status, 400);

    const reqNoTasks = new Request("http://test/api/runs/run-approve-bad/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        approvedTaskIds: [],
        budget: { maxMinutes: 60, maxParallel: 2 },
      }),
    });
    (reqNoTasks as any).runStore = harness.runStore;
    (reqNoTasks as any).eventStore = harness.eventStore;

    const res2 = await POST(reqNoTasks, { params: { runId: "run-approve-bad" } });
    assert.equal(res2.status, 400);
  });

  it("rejects approval when budget exceeds ceiling", async () => {
    const harness = createTestHarness();
    harness.createRun("run-ceiling", "pact_review", {
      maxMinutes: 60,
      maxParallel: 2,
    });
    const tasks = createSampleTasks();

    harness.eventStore.append({
      runId: "run-ceiling",
      kind: "pact.drafted",
      actor: "necromancer",
      data: { pactVersion: 1, tasks, refs: [] },
    });

    const req = new Request("http://test/api/runs/run-ceiling/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        approvedTaskIds: ["T1", "T2", "T3", "T4", "T5"],
        budget: { maxMinutes: 180, maxParallel: 2 }, // Exceeds ceiling 60
      }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-ceiling" } });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, "APPROVAL_REJECTED");
    assert.ok(data.errors.some((e: string) => e.includes("ceiling")));
  });

  it("rejects approval when non-removable requirement is omitted from approvedTaskIds", async () => {
    const harness = createTestHarness();
    harness.createRun("run-approve-omit-lock", "pact_review");
    const tasks = createSampleTasks();

    harness.eventStore.append({
      runId: "run-approve-omit-lock",
      kind: "pact.drafted",
      actor: "necromancer",
      data: { pactVersion: 1, tasks, refs: [] },
    });

    // Omit T3 (Warden final check)
    const req = new Request("http://test/api/runs/run-approve-omit-lock/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        approvedTaskIds: ["T1", "T2", "T4", "T5"],
        budget: { maxMinutes: 60, maxParallel: 2 },
      }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-approve-omit-lock" } });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.ok(data.errors.some((e: string) => e.includes("non-removable")));
  });

  it("records approval, emits pact.approved, and advances phase to legion", async () => {
    const harness = createTestHarness();
    harness.createRun("run-approve-ok", "pact_review");
    const tasks = createSampleTasks();

    harness.eventStore.append({
      runId: "run-approve-ok",
      kind: "pact.drafted",
      actor: "necromancer",
      data: { pactVersion: 1, tasks, refs: [] },
    });

    const req = new Request("http://test/api/runs/run-approve-ok/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        approvedTaskIds: ["T1", "T2", "T3", "T4", "T5"],
        budget: { maxMinutes: 60, maxParallel: 2 },
      }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-approve-ok" } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.pactVersion, 1);
    assert.equal(data.phase, "legion");
    assert.deepEqual(data.approvedTaskIds, ["T1", "T2", "T3", "T4", "T5"]);

    // Verify run phase in store is legion
    const updatedRun = harness.runStore.getRun("run-approve-ok");
    assert.equal(updatedRun?.phase, "legion");

    // Verify pact.approved event
    const appEvents = harness.eventStore.getEvents("run-approve-ok", {
      kind: "pact.approved",
    });
    assert.equal(appEvents.length, 1);
    assert.equal(appEvents[0].data.pactVersion, 1);

    // Verify run.phase event to legion
    const phaseEvents = harness.eventStore.getEvents("run-approve-ok", {
      kind: "run.phase",
    });
    assert.ok(phaseEvents.some((e) => (e.data as any).to === "legion"));
  });
});

describe("Pact API Routes: POST action=revise and action=stop", () => {
  it("processes revise action and emits pact.revision", async () => {
    const harness = createTestHarness();
    harness.createRun("run-rev", "pact_review");

    const req = new Request("http://test/api/runs/run-rev/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "revise",
        prompt: "Please split T2 into two separate tasks",
      }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-rev" } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.status, "revision_requested");
    assert.equal(data.feedback, "Please split T2 into two separate tasks");

    const revEvents = harness.eventStore.getEvents("run-rev", {
      kind: "pact.revision",
    });
    assert.equal(revEvents.length, 1);
    assert.equal(
      revEvents[0].data.feedback,
      "Please split T2 into two separate tasks"
    );
  });

  it("processes stop action, cancels run and emits run.done", async () => {
    const harness = createTestHarness();
    harness.createRun("run-stop", "pact_review");

    const req = new Request("http://test/api/runs/run-stop/pact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "stop",
        reason: "User cancelled during review",
      }),
    });
    (req as any).runStore = harness.runStore;
    (req as any).eventStore = harness.eventStore;

    const res = await POST(req, { params: { runId: "run-stop" } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.status, "stopped");
    assert.equal(data.phase, "done");
    assert.equal(data.outcome, "cancelled");

    const run = harness.runStore.getRun("run-stop");
    assert.equal(run?.phase, "done");
    assert.equal(run?.outcome, "cancelled");

    const doneEvents = harness.eventStore.getEvents("run-stop", {
      kind: "run.done",
    });
    assert.equal(doneEvents.length, 1);
    assert.equal(doneEvents[0].data.outcome, "cancelled");
  });

  it("PUT and PATCH methods behave equivalently to POST", async () => {
    const harness = createTestHarness();
    harness.createRun("run-put", "pact_review");

    const reqPut = new Request("http://test/api/runs/run-put/pact", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    (reqPut as any).runStore = harness.runStore;
    (reqPut as any).eventStore = harness.eventStore;

    const resPut = await PUT(reqPut, { params: { runId: "run-put" } });
    assert.equal(resPut.status, 200);
    const dataPut = await resPut.json();
    assert.equal(dataPut.status, "stopped");

    harness.createRun("run-patch", "pact_review");
    const reqPatch = new Request("http://test/api/runs/run-patch/pact", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    (reqPatch as any).runStore = harness.runStore;
    (reqPatch as any).eventStore = harness.eventStore;

    const resPatch = await PATCH(reqPatch, { params: { runId: "run-patch" } });
    assert.equal(resPatch.status, 200);
    const dataPatch = await resPatch.json();
    assert.equal(dataPatch.status, "stopped");
  });
});
