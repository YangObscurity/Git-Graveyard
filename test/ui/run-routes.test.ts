import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canOpenStage,
  describeOutcome,
  hrefForRun,
  repoFromUrl,
  routes,
  runIdFromPath,
  stageForPhase,
  stageLockedReason,
} from "@/lib/ui/run-routes";
import { describeStartRunError, eventStreamUrl } from "@/lib/ui/api";

describe("run-routes", () => {
  it("builds encoded paths", () => {
    assert.equal(routes.tomb("o w", "r"), "/tomb/o%20w/r");
    assert.equal(routes.pact("run-1"), "/runs/run-1/pact");
    assert.equal(routes.legion("run-1"), "/runs/run-1/legion");
    assert.equal(routes.relic("run-1"), "/runs/run-1/relic");
    assert.equal(routes.replay("run-1"), "/replay/run-1");
    assert.equal(routes.eventLog("run-1"), "/api/runs/run-1/events?from=1");
  });

  it("sends each phase to the screen that handles it", () => {
    assert.equal(stageForPhase("queued"), "legion");
    assert.equal(stageForPhase("exhume"), "legion");
    assert.equal(stageForPhase("plan"), "legion");
    assert.equal(stageForPhase("pact_review"), "pact");
    assert.equal(stageForPhase("legion"), "legion");
    assert.equal(stageForPhase("final_check"), "legion");
    assert.equal(stageForPhase("report"), "legion");
    assert.equal(stageForPhase("done"), "relic");
    assert.equal(stageForPhase(null), "legion");
    assert.equal(hrefForRun("r1", "pact_review"), "/runs/r1/pact");
    assert.equal(hrefForRun("r1", "done"), "/runs/r1/relic");
  });

  it("opens stages only once the run has reached them", () => {
    assert.equal(canOpenStage("legion", "queued"), true);
    assert.equal(canOpenStage("legion", null), true);
    assert.equal(canOpenStage("pact", "queued"), false);
    assert.equal(canOpenStage("pact", "exhume"), false);
    assert.equal(canOpenStage("pact", "plan"), true);
    assert.equal(canOpenStage("pact", "done"), true);
    assert.equal(canOpenStage("relic", "legion"), false);
    assert.equal(canOpenStage("relic", "final_check"), true);
    assert.equal(canOpenStage("relic", "done"), true);
    assert.equal(canOpenStage("relic", undefined), false);

    assert.equal(stageLockedReason("pact", "plan"), null);
    assert.match(stageLockedReason("pact", "queued") ?? "", /after the Exhume/);
    assert.match(stageLockedReason("relic", "legion") ?? "", /final check/);
  });

  it("parses repositories and run ids", () => {
    assert.deepEqual(repoFromUrl("https://github.com/request/request"), { owner: "request", repo: "request" });
    assert.deepEqual(repoFromUrl("git@github.com:o/r.git"), { owner: "o", repo: "r" });
    assert.deepEqual(repoFromUrl("https://github.com/o/r/tree/main"), { owner: "o", repo: "r" });
    assert.equal(repoFromUrl("https://example.com/o/r"), null);
    assert.equal(repoFromUrl(null), null);

    assert.equal(runIdFromPath("/runs/run-9/legion"), "run-9");
    assert.equal(runIdFromPath("/replay/run-9"), "run-9");
    assert.equal(runIdFromPath("/history"), null);
  });

  it("labels every lifecycle outcome without inventing one", () => {
    assert.deepEqual(describeOutcome("resurrected"), { label: "Resurrected", tone: "emerald" });
    assert.equal(describeOutcome("partial").tone, "amber");
    assert.equal(describeOutcome("not_resurrected").tone, "crimson");
    assert.equal(describeOutcome("cancelled").tone, "neutral");
    assert.deepEqual(describeOutcome(null), { label: "not reported", tone: "neutral" });
  });
});

describe("api helpers", () => {
  it("resumes the stream after the last stored seq", () => {
    assert.equal(eventStreamUrl("r1", 0), "/api/runs/r1/events");
    assert.equal(eventStreamUrl("r1", 41), "/api/runs/r1/events?lastEventId=41");
  });

  it("maps each start-run refusal to its own plain message", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ code: "MISSING_INVITE_CODE" }, /invite code is required/],
      [{ code: "INVALID_INVITE_CODE" }, /not recognized/],
      [{ code: "EXPIRED_INVITE_CODE" }, /has expired/],
      [{ code: "REVOKED_INVITE_CODE" }, /revoked by the owner/],
      [{ code: "RUN_LIMIT_REACHED" }, /no remaining runs/],
      [{ code: "PAUSED" }, /paused by the owner/],
      [{ code: "UNAVAILABLE" }, /currently unavailable/],
      [{ code: "QUEUE_FULL" }, /queue is full/],
      [{ code: "RATE_LIMITED", resetTime: "12:00Z" }, /Reset time: 12:00Z/],
    ];
    const seen = new Set<string>();
    for (const [data, pattern] of cases) {
      const message = describeStartRunError(403, data);
      assert.match(message, pattern);
      seen.add(message);
    }
    assert.equal(seen.size, cases.length);
    assert.match(describeStartRunError(500, {}), /status 500/);
  });
});
