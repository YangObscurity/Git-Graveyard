import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RunStore } from "../../lib/runs/run-store";
import { EventStore } from "../../lib/events/event-store";
import {
  executePactMutation,
  executePactEdit,
  executePactApprove,
  executePactRevise,
  executePactStop,
  extractPactState,
  extractCallerCredentials,
  checkRunAuthorization,
  checkPhaseConstraints,
  inferPactAction,
} from "../../lib/pact/pact-mutation";
import type { PactTask } from "../../lib/pact/pact-parser";
import { renderPact } from "../../lib/pact/pact-renderer";

function createTestHarness(options?: { withInviteCode?: string }) {
  const db = new DatabaseSync(":memory:");
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
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 15,
    },
    {
      id: "T4",
      title: "Scribe report compilation",
      role: "bonesetter",
      dependencies: ["T3"],
      depends: ["T3"],
      dependsOn: ["T3"],
      files: ["package.json"],
      filesInScope: ["package.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 22,
    },
    {
      id: "T5",
      title: "Grimoire syntax gate verification",
      role: "bonesetter",
      dependencies: ["T4"],
      depends: ["T4"],
      dependsOn: ["T4"],
      files: ["package.json"],
      filesInScope: ["package.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 29,
    },
  ];
}

describe("Pact Mutation: Authorization and Credentials", () => {
  it("allows requests when run has no invite code required", () => {
    const harness = createTestHarness();
    const run = harness.createRun("run-no-invite");
    const result = checkRunAuthorization(run);
    assert.equal(result.authorized, true);
    assert.equal(result.status, 200);
  });

  it("rejects mutating request when invite code is required but missing", () => {
    const harness = createTestHarness({ withInviteCode: "VALID_CODE" });
    const run = harness.createRun("run-needs-invite");
    const result = checkRunAuthorization(run);
    assert.equal(result.authorized, false);
    assert.equal(result.status, 401);
  });

  it("rejects mutating request when invite code is incorrect", () => {
    const harness = createTestHarness({ withInviteCode: "VALID_CODE" });
    const run = harness.createRun("run-needs-invite");
    const result = checkRunAuthorization(run, undefined, { inviteCode: "WRONG_CODE" }, harness.runStore);
    assert.equal(result.authorized, false);
    assert.equal(result.status, 403);
  });

  it("allows mutating request with matching invite code", () => {
    const harness = createTestHarness({ withInviteCode: "VALID_CODE" });
    const run = harness.createRun("run-needs-invite");
    const result = checkRunAuthorization(run, undefined, { inviteCode: "VALID_CODE" }, harness.runStore);
    assert.equal(result.authorized, true);
    assert.equal(result.status, 200);
  });

  it("rejects spoofed x-admin / unset-env bypasses and allows verified ADMIN_TOKEN override", () => {
    const prevAdminToken = process.env.ADMIN_TOKEN;
    const prevAdminKey = process.env.ADMIN_KEY;
    try {
      delete process.env.ADMIN_TOKEN;
      delete process.env.ADMIN_KEY;

      const harness = createTestHarness({ withInviteCode: "VALID_CODE" });
      const run = harness.createRun("run-needs-invite");

      // Unset env: x-admin and x-admin-key must both be rejected
      const unsetBypass = checkRunAuthorization(
        run,
        { "x-admin": "true", "x-admin-key": "anything" },
        undefined,
        harness.runStore
      );
      assert.equal(unsetBypass.authorized, false);
      assert.equal(unsetBypass.status, 401);

      process.env.ADMIN_TOKEN = "pact-mutation-admin-secret";

      // Spoofed x-admin: true without matching token must be rejected
      const spoofed = checkRunAuthorization(
        run,
        { "x-admin": "true" },
        undefined,
        harness.runStore
      );
      assert.equal(spoofed.authorized, false);
      assert.equal(spoofed.status, 401);

      // Valid x-admin-token header succeeds
      const result = checkRunAuthorization(
        run,
        { "x-admin-token": "pact-mutation-admin-secret" },
        undefined,
        harness.runStore
      );
      assert.equal(result.authorized, true);
      assert.equal(result.status, 200);
    } finally {
      if (prevAdminToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = prevAdminToken;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
    }
  });

  it("extracts credentials from headers and query parameters", () => {
    const creds1 = extractCallerCredentials({ "x-invite-code": "MY_INVITE" });
    assert.equal(creds1.inviteCode, "MY_INVITE");

    const creds2 = extractCallerCredentials({ authorization: "Bearer BEARER_TOKEN" });
    assert.equal(creds2.inviteCode, "BEARER_TOKEN");

    const reqWithUrl = new Request("https://example.com/api/runs/123/pact?inviteCode=QUERY_CODE");
    const creds3 = extractCallerCredentials(reqWithUrl);
    assert.equal(creds3.inviteCode, "QUERY_CODE");
  });
});

describe("Pact Mutation: Phase Constraints and Validation", () => {
  it("rejects missing runId or non-object body", () => {
    const harness = createTestHarness();
    const res1 = executePactMutation("", {}, harness.runStore, harness.eventStore);
    assert.equal(res1.ok, false);
    assert.equal(res1.status, 400);
    assert.equal(res1.code, "MISSING_RUN_ID");

    const res2 = executePactMutation("run-1", null, harness.runStore, harness.eventStore);
    assert.equal(res2.ok, false);
    assert.equal(res2.status, 400);
    assert.equal(res2.code, "BAD_REQUEST");
  });

  it("rejects unknown or missing action", () => {
    const harness = createTestHarness();
    harness.createRun("run-1");
    const res = executePactMutation("run-1", {}, harness.runStore, harness.eventStore);
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.code, "MISSING_ACTION");
  });

  it("rejects edit or approve when run is in queued phase", () => {
    const harness = createTestHarness();
    harness.createRun("run-queued", "queued");
    const res = executePactMutation(
      "run-queued",
      { action: "edit", tasks: createSampleTasks() },
      harness.runStore,
      harness.eventStore
    );
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(res.code, "INVALID_RUN_PHASE");
  });

  it("rejects modification when run is already done", () => {
    const harness = createTestHarness();
    harness.createRun("run-done", "done");
    const res = executePactMutation(
      "run-done",
      { action: "edit", tasks: createSampleTasks() },
      harness.runStore,
      harness.eventStore
    );
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(res.code, "RUN_COMPLETED");
  });

  it("allows stop action when run is already done", () => {
    const harness = createTestHarness();
    harness.createRun("run-done", "done");
    const res = executePactMutation(
      "run-done",
      { action: "stop" },
      harness.runStore,
      harness.eventStore
    );
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.phase, "done");
  });
});

describe("Pact Mutation: Action Edit (Requirements 13.2, 13.5, 36.14)", () => {
  it("processes valid task edit, increments pactVersion, and emits pact.edited", () => {
    const harness = createTestHarness();
    harness.createRun("run-edit-1", "plan");
    const tasks = createSampleTasks();

    const res = executePactMutation(
      "run-edit-1",
      { action: "edit", tasks },
      harness.runStore,
      harness.eventStore
    );

    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.pactVersion, 1);
    assert.equal(res.tasks?.length, 5);

    // Verify clock was paused when advancing from plan to pact_review (Requirement 13.1)
    const run = harness.runStore.getRun("run-edit-1");
    assert.equal(run?.phase, "pact_review");

    const clockEvents = harness.eventStore.getEvents("run-edit-1", { kinds: ["run.clock"] });
    assert.equal(clockEvents.length, 1);
    assert.equal((clockEvents[0].data as any).action, "pause");

    // Verify pact.edited event
    const editEvents = harness.eventStore.getEvents("run-edit-1", { kinds: ["pact.edited"] });
    assert.equal(editEvents.length, 1);
    assert.equal((editEvents[0].data as any).pactVersion, 1);
  });

  it("supports edit via raw Markdown string", () => {
    const harness = createTestHarness();
    harness.createRun("run-edit-md", "pact_review");
    const tasks = createSampleTasks();
    const markdown = renderPact(tasks);

    const res = executePactMutation(
      "run-edit-md",
      { action: "edit", markdown },
      harness.runStore,
      harness.eventStore
    );

    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.pactVersion, 1);
    assert.equal(res.tasks?.length, 5);
  });

  it("rejects invalid Markdown syntax", () => {
    const harness = createTestHarness();
    harness.createRun("run-edit-bad-md", "pact_review");

    const res = executePactMutation(
      "run-edit-bad-md",
      { action: "edit", markdown: "Invalid text with no checkboxes" },
      harness.runStore,
      harness.eventStore
    );

    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.code, "PARSE_ERROR");
  });

  it("rejects edit that removes non-removable requirements (Requirement 13.5)", () => {
    const harness = createTestHarness();
    harness.createRun("run-remove-nonremovable", "pact_review");
    const originalTasks = createSampleTasks();

    harness.eventStore.append({
      runId: "run-remove-nonremovable",
      kind: "pact.drafted",
      actor: "necromancer",
      data: { pactVersion: 1, tasks: originalTasks, refs: [] },
    });

    // Only non-warden tasks
    const tasks: PactTask[] = [
      {
        id: "T1",
        title: "Fix something",
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
    ];

    const res = executePactMutation(
      "run-remove-nonremovable",
      { action: "edit", tasks },
      harness.runStore,
      harness.eventStore
    );

    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.code, "VALIDATION_FAILED");
  });

  it("rejects edit that introduces dependency cycles", () => {
    const harness = createTestHarness();
    harness.createRun("run-cycle", "pact_review");

    const base = createSampleTasks();
    base[0].dependencies = ["T2"];
    base[0].depends = ["T2"];
    base[1].dependencies = ["T1"];
    base[1].depends = ["T1"];

    const res = executePactMutation(
      "run-cycle",
      { action: "edit", tasks: base },
      harness.runStore,
      harness.eventStore
    );

    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.code, "VALIDATION_FAILED");
  });

  it("rejects edit that has blocked commands under CommandPolicy", () => {
    const harness = createTestHarness();
    harness.createRun("run-blocked", "pact_review");

    const base = createSampleTasks();
    base[0].acceptanceCommand = "sudo rm -rf /";
    base[0].accept = "sudo rm -rf /";

    const res = executePactMutation(
      "run-blocked",
      { action: "edit", tasks: base },
      harness.runStore,
      harness.eventStore
    );

    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.code, "VALIDATION_FAILED");
  });
});

describe("Pact Mutation: Action Approve (Requirements 13.4, 13.8)", () => {
  it("rejects approval if approvedTaskIds is empty or budget is missing", () => {
    const harness = createTestHarness();
    harness.createRun("run-appr-bad", "pact_review");

    const res1 = executePactMutation(
      "run-appr-bad",
      { action: "approve", approvedTaskIds: [] },
      harness.runStore,
      harness.eventStore
    );
    assert.equal(res1.ok, false);
    assert.equal(res1.code, "MISSING_APPROVED_TASKS");

    const res2 = executePactMutation(
      "run-appr-bad",
      { action: "approve", approvedTaskIds: ["T1"] },
      harness.runStore,
      harness.eventStore
    );
    assert.equal(res2.ok, false);
    assert.equal(res2.code, "MISSING_BUDGET");
  });

  it("records approval, emits pact.approved, and advances phase to legion", () => {
    const harness = createTestHarness();
    harness.createRun("run-appr-ok", "pact_review");
    const tasks = createSampleTasks();

    // Draft/edit pact first
    executePactMutation(
      "run-appr-ok",
      { action: "edit", tasks },
      harness.runStore,
      harness.eventStore
    );

    const approveRes = executePactMutation(
      "run-appr-ok",
      {
        action: "approve",
        approvedTaskIds: ["T1", "T2", "T3", "T4", "T5"],
        budget: { maxMinutes: 60, maxParallel: 2 },
      },
      harness.runStore,
      harness.eventStore
    );

    assert.equal(approveRes.ok, true);
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.phase, "legion");

    // Check run store updated to legion
    const run = harness.runStore.getRun("run-appr-ok");
    assert.equal(run?.phase, "legion");

    // Check pact.approved event emitted
    const apprEvents = harness.eventStore.getEvents("run-appr-ok", { kinds: ["pact.approved"] });
    assert.equal(apprEvents.length, 1);
    assert.deepEqual((apprEvents[0].data as any).approvedTaskIds, ["T1", "T2", "T3", "T4", "T5"]);

    // Check run clock resumed
    const resumeEvents = harness.eventStore.getEvents("run-appr-ok", { kinds: ["run.clock"] });
    const lastClock = resumeEvents[resumeEvents.length - 1];
    assert.equal((lastClock.data as any).action, "resume");
  });
});

describe("Pact Mutation: Action Revise and Action Stop", () => {
  it("processes revise action and emits pact.revision (Requirement 13.3)", () => {
    const harness = createTestHarness();
    harness.createRun("run-rev", "pact_review");
    executePactMutation(
      "run-rev",
      { action: "edit", tasks: createSampleTasks() },
      harness.runStore,
      harness.eventStore
    );

    const res = executePactMutation(
      "run-rev",
      { action: "revise", feedback: "Please optimize T2" },
      harness.runStore,
      harness.eventStore
    );

    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.feedback, "Please optimize T2");

    const revEvents = harness.eventStore.getEvents("run-rev", { kinds: ["pact.revision"] });
    assert.equal(revEvents.length, 1);
    assert.equal((revEvents[0].data as any).feedback, "Please optimize T2");
  });

  it("processes stop action, cancels run and emits run.done", () => {
    const harness = createTestHarness();
    harness.createRun("run-stop", "pact_review");

    const res = executePactMutation(
      "run-stop",
      { action: "stop", reason: "user requested abort" },
      harness.runStore,
      harness.eventStore
    );

    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.phase, "done");
    assert.equal(res.outcome, "cancelled");

    const run = harness.runStore.getRun("run-stop");
    assert.equal(run?.phase, "done");
    assert.equal(run?.outcome, "cancelled");

    const doneEvents = harness.eventStore.getEvents("run-stop", { kinds: ["run.done"] });
    assert.equal(doneEvents.length, 1);
    assert.equal((doneEvents[0].data as any).outcome, "cancelled");
  });
});
