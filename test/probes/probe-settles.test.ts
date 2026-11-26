import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveHomeIsolation,
  resolvePermissionForm,
  resolveSingleSkeletonLimit,
  resolveSandboxFallback,
} from "../../lib/probes/probe-settles";

describe("Phase 0 Probe Settles: resolveHomeIsolation (P4)", () => {
  it("returns 'not passed' when P4 outcome is missing or null or undefined", () => {
    assert.equal(resolveHomeIsolation(undefined), "not passed");
    assert.equal(resolveHomeIsolation(null), "not passed");
    assert.equal(resolveHomeIsolation({}), "not passed");
    assert.equal(resolveHomeIsolation({ P4: { id: "P4", passed: false, outcome: "not_passed" } }), "not passed");
  });

  it("resolves standard setting when P4 passes", () => {
    const outcome = { id: "P4", passed: true, outcome: "pass" };
    const res = resolveHomeIsolation(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "standard");
      assert.equal(res.fallbackChosen, false);
      assert.equal(res.fallback, "none");
      assert.equal(res.isolatedHome, false);
      assert.equal(res.agentsDir, "$KIRO_HOME/agents");
      assert.equal(res.perSkeletonHome, false);
      assert.equal(res.strategy, "global");
      assert.equal(res.setting.strategy, "global");
      assert.match(res.why, /Probe P4 passed/);
    }
  });

  it("resolves per-skeleton-home fallback when P4 fails", () => {
    const outcome = { id: "P4", passed: false, outcome: "fail" };
    const res = resolveHomeIsolation(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "fallback");
      assert.equal(res.fallbackChosen, true);
      assert.equal(res.fallback, "per-skeleton-home");
      assert.equal(res.isolatedHome, true);
      assert.equal(res.agentsDir, "~/.kiro/agents");
      assert.equal(res.perSkeletonHome, true);
      assert.equal(res.strategy, "per-skeleton-home");
      assert.equal(res.setting.strategy, "per-skeleton-home");
      assert.match(res.why, /isolated HOME/i);
    }
  });

  it("works when called with a full probe results map", () => {
    const records = {
      P4: { id: "P4", passed: true, outcome: "passed" },
      P1: { id: "P1", passed: false, outcome: "fail" },
    };
    const res = resolveHomeIsolation(records);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "standard");
      assert.equal(res.strategy, "global");
    }
  });
});

describe("Phase 0 Probe Settles: resolvePermissionForm (P6)", () => {
  it("returns 'not passed' when P6 is missing", () => {
    assert.equal(resolvePermissionForm(undefined), "not passed");
    assert.equal(resolvePermissionForm(null), "not passed");
    assert.equal(resolvePermissionForm({}), "not passed");
    assert.equal(resolvePermissionForm({ P6: { id: "P6", passed: false, outcome: "not passed" } }), "not passed");
  });

  it("resolves candidate-deny-exclude standard setting when P6 passes", () => {
    const outcome = { id: "P6", passed: true, outcome: "passed" };
    const res = resolvePermissionForm(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "standard");
      assert.equal(res.fallbackChosen, false);
      assert.equal(res.fallback, "none");
      assert.equal(res.form, "candidate-deny-exclude");
      assert.equal(res.explicitPathsAllowed, true);
      assert.equal(res.otherActions, "deny");
      assert.equal(res.brokerRejects, false);
      assert.equal(res.setting.form, "candidate-deny-exclude");
    }
  });

  it("resolves documented-safe fallback when P6 fails", () => {
    const outcome = { id: "P6", passed: false, outcome: "failed" };
    const res = resolvePermissionForm(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "fallback");
      assert.equal(res.fallbackChosen, true);
      assert.equal(res.fallback, "documented-safe");
      assert.equal(res.form, "documented-safe");
      assert.equal(res.explicitPathsAllowed, true);
      assert.equal(res.otherActions, "ask");
      assert.equal(res.brokerRejects, true);
      assert.equal(res.setting.form, "documented-safe");
    }
  });

  it("works when called with a full probe results map", () => {
    const records = {
      P6: { id: "P6", passed: false, outcome: "failed" },
    };
    const res = resolvePermissionForm(records);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "fallback");
      assert.equal(res.form, "documented-safe");
    }
  });
});

describe("Phase 0 Probe Settles: resolveSingleSkeletonLimit (P8 and S4)", () => {
  it("returns 'not passed' when either P8 or S4 is missing", () => {
    assert.equal(resolveSingleSkeletonLimit(undefined, undefined), "not passed");
    assert.equal(resolveSingleSkeletonLimit({}, null), "not passed");

    const p8Pass = { id: "P8", passed: true, outcome: "ok" };
    const s4Pass = { id: "S4", passed: true, outcome: "ok" };

    assert.equal(resolveSingleSkeletonLimit(p8Pass, undefined), "not passed");
    assert.equal(resolveSingleSkeletonLimit(undefined, s4Pass), "not passed");
    assert.equal(resolveSingleSkeletonLimit({ P8: p8Pass }), "not passed");
    assert.equal(resolveSingleSkeletonLimit({ S4: s4Pass }), "not passed");
  });

  it("resolves standard setting (max 4 skeletons) when both P8 and S4 pass", () => {
    const p8 = { id: "P8", passed: true, outcome: "pass" };
    const s4 = { id: "S4", passed: true, outcome: "pass" };

    const res = resolveSingleSkeletonLimit(p8, s4);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "standard");
      assert.equal(res.fallbackChosen, false);
      assert.equal(res.fallback, "none");
      assert.equal(res.limitToOneSkeleton, false);
      assert.equal(res.maxConcurrentSkeletons, 4);
      assert.equal(res.concurrencyLimit, 4);
      assert.equal(res.setting.concurrencyLimit, 4);
    }
  });

  it("resolves single-skeleton fallback when P8 fails and S4 passes", () => {
    const p8 = { id: "P8", passed: false, outcome: "fail" };
    const s4 = { id: "S4", passed: true, outcome: "pass" };

    const res = resolveSingleSkeletonLimit(p8, s4);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "fallback");
      assert.equal(res.fallbackChosen, true);
      assert.equal(res.fallback, "single-skeleton");
      assert.equal(res.limitToOneSkeleton, true);
      assert.equal(res.maxConcurrentSkeletons, 1);
      assert.equal(res.concurrencyLimit, 1);
    }
  });

  it("resolves single-skeleton fallback when P8 passes and S4 fails", () => {
    const p8 = { id: "P8", passed: true, outcome: "pass" };
    const s4 = { id: "S4", passed: false, outcome: "fail" };

    const res = resolveSingleSkeletonLimit(p8, s4);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "fallback");
      assert.equal(res.fallbackChosen, true);
      assert.equal(res.limitToOneSkeleton, true);
      assert.equal(res.maxConcurrentSkeletons, 1);
    }
  });

  it("resolves single-skeleton fallback when both fail", () => {
    const p8 = { id: "P8", passed: false, outcome: "fail" };
    const s4 = { id: "S4", passed: false, outcome: "fail" };

    const res = resolveSingleSkeletonLimit(p8, s4);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "fallback");
      assert.equal(res.limitToOneSkeleton, true);
      assert.equal(res.maxConcurrentSkeletons, 1);
    }
  });

  it("works when called with a combined results map", () => {
    const records = {
      P8: { id: "P8", passed: true, outcome: "ok" },
      S4: { id: "S4", passed: true, outcome: "ok" },
    };
    const res = resolveSingleSkeletonLimit(records);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "standard");
      assert.equal(res.limitToOneSkeleton, false);
      assert.equal(res.concurrencyLimit, 4);
    }
  });
});

describe("Phase 0 Probe Settles: resolveSandboxFallback (P9)", () => {
  it("returns 'not passed' when P9 is missing", () => {
    assert.equal(resolveSandboxFallback(undefined), "not passed");
    assert.equal(resolveSandboxFallback(null), "not passed");
    assert.equal(resolveSandboxFallback({}), "not passed");
    assert.equal(resolveSandboxFallback({ P9: { id: "P9", passed: false, outcome: "not_passed" } }), "not passed");
  });

  it("resolves standard setting (internal sandbox enabled) when P9 passes", () => {
    const outcome = { id: "P9", passed: true, outcome: "pass" };
    const res = resolveSandboxFallback(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "standard");
      assert.equal(res.fallbackChosen, false);
      assert.equal(res.fallback, "none");
      assert.equal(res.internalSandboxEnabled, true);
      assert.equal(res.sandboxDisabled, false);
      assert.equal(res.spawnStdioShim, false);
      assert.equal(res.sanitizedEnvironment, false);
      assert.equal(res.setting.internalSandboxEnabled, true);
    }
  });

  it("resolves disable-internal-sandbox fallback when P9 fails", () => {
    const outcome = { id: "P9", passed: false, outcome: "failed" };
    const res = resolveSandboxFallback(outcome);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "fallback");
      assert.equal(res.fallbackChosen, true);
      assert.equal(res.fallback, "disable-internal-sandbox-sanitized-stdio-shim");
      assert.equal(res.internalSandboxEnabled, false);
      assert.equal(res.sandboxDisabled, true);
      assert.equal(res.spawnStdioShim, true);
      assert.equal(res.sanitizedEnvironment, true);
      assert.equal(res.setting.internalSandboxEnabled, false);
    }
  });

  it("works when called with a full probe results map", () => {
    const records = {
      P9: { id: "P9", passed: true, outcome: "passed" },
    };
    const res = resolveSandboxFallback(records);
    assert.notEqual(res, "not passed");
    if (res !== "not passed") {
      assert.equal(res.status, "standard");
      assert.equal(res.internalSandboxEnabled, true);
    }
  });
});
