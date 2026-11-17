import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  symlinkScanRequired,
  creditsDisplayPolicy,
  headlessFallbackState,
  acpLoadHandling,
  creditBalanceSource,
} from "../../lib/probes/probe-fallbacks";

describe("Phase 0 Probe Fallbacks: symlinkScanRequired (P12)", () => {
  it("returns 'not passed' when P12 is missing", () => {
    assert.equal(symlinkScanRequired(undefined), "not passed");
    assert.equal(symlinkScanRequired(null), "not passed");
    assert.equal(symlinkScanRequired({}), "not passed");
    assert.equal(symlinkScanRequired({ P12: { id: "P12", passed: false, outcome: "not_passed" } }), "not passed");
  });

  it("enforces mandatory scan even when P12 passes and does not follow symlinks", () => {
    const outcome = { id: "P12", passed: true, outcome: "safe: does not follow symlinks" };
    const res = symlinkScanRequired(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.required, true);
      assert.equal(res.mandatory, true);
      assert.equal(res.scanTiming, "before_every_prompt_and_after_every_sandbox_exec");
      assert.equal(res.timing, "before_every_prompt_and_after_every_sandbox_exec");
      assert.equal(res.scanBeforePrompt, true);
      assert.equal(res.scanAfterSandboxExec, true);
      assert.equal(res.enforceMandatoryScan, true);
      assert.equal(
        res.policy,
        "mandatory symlink scan before every prompt and after every sandbox_exec"
      );
      assert.equal(Boolean(res.valueOf()), true);
    }
  });

  it("enforces mandatory scan when P12 fails", () => {
    const outcome = { id: "P12", passed: false, outcome: "fail" };
    const res = symlinkScanRequired(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.required, true);
      assert.equal(res.mandatory, true);
      assert.equal(res.scanTiming, "before_every_prompt_and_after_every_sandbox_exec");
      assert.equal(res.timing, "before_every_prompt_and_after_every_sandbox_exec");
      assert.equal(res.scanBeforePrompt, true);
      assert.equal(res.scanAfterSandboxExec, true);
      assert.equal(res.enforceMandatoryScan, true);
      assert.equal(
        res.policy,
        "mandatory symlink scan before every prompt and after every sandbox_exec"
      );
      assert.equal(Boolean(res.valueOf()), true);
    }
  });

  it("enforces mandatory scan when outcome text indicates file tools follow symlinks", () => {
    const outcome = { id: "P12", passed: true, outcome: "warning: tools follow symlinks" };
    const res = symlinkScanRequired(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.required, true);
      assert.equal(res.mandatory, true);
      assert.equal(Boolean(res.valueOf()), true);
    }
  });

  it("extracts from a full probe results map", () => {
    const records = {
      P12: { id: "P12", passed: false, outcome: "failed" },
    };
    const res = symlinkScanRequired(records);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.required, true);
    }
  });
});

describe("Phase 0 Probe Fallbacks: creditsDisplayPolicy (P5)", () => {
  it("returns 'not passed' when P5 is missing", () => {
    assert.equal(creditsDisplayPolicy(undefined), "not passed");
    assert.equal(creditsDisplayPolicy(null), "not passed");
    assert.equal(creditsDisplayPolicy({}), "not passed");
    assert.equal(creditsDisplayPolicy({ P5: { id: "P5", passed: false, outcome: "not_passed" } }), "not passed");
  });

  it("reports credits and enforces credit cap when P5 passes and reports credits", () => {
    const outcome = { id: "P5", passed: true, outcome: "credits reported in summaries" };
    const res = creditsDisplayPolicy(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.capsApplyTo, "credits_wall_clock_and_tool_calls");
      assert.deepEqual(res.caps, ["wall_clock", "tool_calls", "credits"]);
      assert.equal(res.wallClockAndToolCallsOnly, false);
      assert.equal(res.creditsCapEnforced, true);
      assert.equal(res.uiDisplay, "reported");
      assert.equal(res.creditsDisplay, "reported");
      assert.equal(res.displayCredits, "reported");
      assert.equal(res.estimateCredits, false);
    }
  });

  it("restricts caps to wall clock and tool calls only when P5 fails", () => {
    const outcome = { id: "P5", passed: false, outcome: "failed" };
    const res = creditsDisplayPolicy(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.capsApplyTo, "wall_clock_and_tool_calls_only");
      assert.deepEqual(res.caps, ["wall_clock", "tool_calls"]);
      assert.equal(res.wallClockAndToolCallsOnly, true);
      assert.equal(res.creditsCapEnforced, false);
      assert.equal(res.uiDisplay, "not reported");
      assert.equal(res.creditsDisplay, "not reported");
      assert.equal(res.displayCredits, "not reported");
      assert.equal(res.estimateCredits, false);
    }
  });

  it("restricts caps when outcome text explicitly mentions lack of credits", () => {
    const outcome = { id: "P5", passed: true, outcome: "turn_completion lacks credits" };
    const res = creditsDisplayPolicy(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.wallClockAndToolCallsOnly, true);
      assert.equal(res.uiDisplay, "not reported");
    }
  });
});

describe("Phase 0 Probe Fallbacks: headlessFallbackState (P1 and P14)", () => {
  it("returns 'not passed' when either P1 or P14 is missing", () => {
    assert.equal(headlessFallbackState(undefined, undefined), "not passed");
    assert.equal(headlessFallbackState({}, {}), "not passed");

    const p1Pass = { id: "P1", passed: true, outcome: "ok" };
    const p14Pass = { id: "P14", passed: true, outcome: "ok" };

    assert.equal(headlessFallbackState(p1Pass, undefined), "not passed");
    assert.equal(headlessFallbackState(undefined, p14Pass), "not passed");
    assert.equal(headlessFallbackState({ P1: p1Pass }), "not passed");
    assert.equal(headlessFallbackState({ P14: p14Pass }), "not passed");
  });

  it("keeps ACP_V3 channel and enables live runs when both P1 and P14 pass", () => {
    const p1 = { id: "P1", passed: true, outcome: "pass" };
    const p14 = { id: "P14", passed: true, outcome: "pass" };

    const res = headlessFallbackState(p1, p14);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.channel, "ACP_V3");
      assert.equal(res.active, false);
      assert.equal(res.headlessFallbackActive, false);
      assert.equal(res.disabledForLiveRuns, false);
      assert.equal(res.liveRunsDisabled, false);
      assert.equal(res.liveRunsAllowed, true);
      assert.equal(res.liveRunsEnabled, true);
      assert.equal(Boolean(res.valueOf()), false);
    }
  });

  it("activates Headless_Fallback channel with live runs enabled when P1 fails and P14 passes", () => {
    const p1 = { id: "P1", passed: false, outcome: "failed" };
    const p14 = { id: "P14", passed: true, outcome: "passed" };

    const res = headlessFallbackState(p1, p14);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.channel, "Headless_Fallback");
      assert.equal(res.active, true);
      assert.equal(res.headlessFallbackActive, true);
      assert.equal(res.disabledForLiveRuns, false);
      assert.equal(res.liveRunsDisabled, false);
      assert.equal(res.liveRunsAllowed, true);
      assert.equal(Boolean(res.valueOf()), true);
    }
  });

  it("activates Headless_Fallback but disables live runs when both P1 and P14 fail", () => {
    const p1 = { id: "P1", passed: false, outcome: "failed" };
    const p14 = { id: "P14", passed: false, outcome: "cannot verify active model" };

    const res = headlessFallbackState(p1, p14);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.channel, "Headless_Fallback");
      assert.equal(res.active, true);
      assert.equal(res.headlessFallbackActive, true);
      assert.equal(res.disabledForLiveRuns, true);
      assert.equal(res.liveRunsDisabled, true);
      assert.equal(res.liveRunsAllowed, false);
      assert.equal(res.liveRunsEnabled, false);
      assert.equal(Boolean(res.valueOf()), true);
    }
  });

  it("disables live runs when P14 text indicates model cannot be verified", () => {
    const p1 = { id: "P1", passed: false, outcome: "fail" };
    const p14 = { id: "P14", passed: true, outcome: "stream-json cannot verify active model" };

    const res = headlessFallbackState(p1, p14);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.disabledForLiveRuns, true);
      assert.equal(res.liveRunsAllowed, false);
    }
  });

  it("extracts from a combined results map", () => {
    const records = {
      P1: { id: "P1", passed: false, outcome: "failed" },
      P14: { id: "P14", passed: true, outcome: "ok" },
    };
    const res = headlessFallbackState(records);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.channel, "Headless_Fallback");
      assert.equal(res.active, true);
      assert.equal(res.liveRunsAllowed, true);
    }
  });
});

describe("Phase 0 Probe Fallbacks: acpLoadHandling (P7)", () => {
  it("returns 'not passed' when P7 is missing", () => {
    assert.equal(acpLoadHandling(undefined), "not passed");
    assert.equal(acpLoadHandling(null), "not passed");
    assert.equal(acpLoadHandling({}), "not passed");
    assert.equal(acpLoadHandling({ P7: { id: "P7", passed: false, outcome: "not_passed" } }), "not passed");
  });

  it("keeps worktree files when P7 passes and does not load repo kiro files", () => {
    const outcome = { id: "P7", passed: true, outcome: "safe: does not load repo files" };
    const res = acpLoadHandling(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.removeLoadedFiles, false);
      assert.equal(res.remove, false);
      assert.equal(res.markSkipWorktree, false);
      assert.equal(res.skipWorktree, false);
      assert.equal(res.action, "keep");
      assert.equal(res.untrustedFilesHandled, false);
      assert.equal(Boolean(res.valueOf()), false);
    }
  });

  it("removes and marks skip-worktree when P7 fails", () => {
    const outcome = { id: "P7", passed: false, outcome: "fail" };
    const res = acpLoadHandling(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.removeLoadedFiles, true);
      assert.equal(res.remove, true);
      assert.equal(res.markSkipWorktree, true);
      assert.equal(res.skipWorktree, true);
      assert.equal(res.action, "remove_and_skip_worktree");
      assert.equal(res.untrustedFilesHandled, true);
      assert.equal(Boolean(res.valueOf()), true);
    }
  });

  it("removes and marks skip-worktree when outcome indicates loading files", () => {
    const outcome = { id: "P7", passed: true, outcome: "warning: session loads repo steering files" };
    const res = acpLoadHandling(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.removeLoadedFiles, true);
      assert.equal(res.action, "remove_and_skip_worktree");
    }
  });
});

describe("Phase 0 Probe Fallbacks: creditBalanceSource (P15)", () => {
  it("returns 'not passed' when P15 is missing", () => {
    assert.equal(creditBalanceSource(undefined), "not passed");
    assert.equal(creditBalanceSource(null), "not passed");
    assert.equal(creditBalanceSource({}), "not passed");
    assert.equal(creditBalanceSource({ P15: { id: "P15", passed: false, outcome: "not_passed" } }), "not passed");
  });

  it("uses getUsage and mcp status when P15 passes", () => {
    const outcome = { id: "P15", passed: true, outcome: "pass: methods advertised" };
    const res = creditBalanceSource(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.creditBalanceSource, "_kiro/account/getUsage");
      assert.equal(res.balanceSource, "_kiro/account/getUsage");
      assert.equal(res.directOwnerToPortal, false);
      assert.equal(res.connectionVerification, "mcp_status");
      assert.equal(res.connectionSource, "mcp_status");
      assert.equal(res.verifyViaGatewayRecords, false);
      assert.equal(res.verifyFromGatewayRecords, false);
    }
  });

  it("directs owner to portal and verifies via gateway records when P15 fails", () => {
    const outcome = { id: "P15", passed: false, outcome: "failed" };
    const res = creditBalanceSource(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.creditBalanceSource, "kiro_portal");
      assert.equal(res.balanceSource, "kiro_portal");
      assert.equal(res.directOwnerToPortal, true);
      assert.equal(res.connectionVerification, "gateway_records");
      assert.equal(res.connectionSource, "gateway_records");
      assert.equal(res.verifyViaGatewayRecords, true);
      assert.equal(res.verifyFromGatewayRecords, true);
    }
  });

  it("directs owner to portal when getUsage is not advertised", () => {
    const outcome = { id: "P15", passed: true, outcome: "getUsage not advertised" };
    const res = creditBalanceSource(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.creditBalanceSource, "kiro_portal");
      assert.equal(res.directOwnerToPortal, true);
    }
  });

  it("verifies via gateway records when no mcp status method is advertised", () => {
    const outcome = { id: "P15", passed: true, outcome: "no mcp status method found" };
    const res = creditBalanceSource(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.connectionVerification, "gateway_records");
      assert.equal(res.verifyViaGatewayRecords, true);
    }
  });
});
