import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEV_REQUIRED_PROBES,
  PROD_REQUIRED_PROBES,
  devLiveRunsAllowed,
  prodLiveRunsAllowed,
} from "../../lib/probes/gate";
import { parseRunsContent } from "../../lib/probes/runs-parser";

describe("Phase 0 Gate: Constants", () => {
  it("defines exactly 18 development required probes and spikes", () => {
    assert.equal(DEV_REQUIRED_PROBES.length, 18);
    const expected = [
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
      "P7",
      "P8",
      "P9",
      "P12",
      "P13",
      "P14",
      "P15",
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
    ];
    assert.deepEqual(Array.from(DEV_REQUIRED_PROBES), expected);
  });

  it("defines exactly 4 production required probes", () => {
    assert.equal(PROD_REQUIRED_PROBES.length, 4);
    const expected = ["P10", "P11", "P16", "P17"];
    assert.deepEqual(Array.from(PROD_REQUIRED_PROBES), expected);
  });
});

describe("Phase 0 Gate: Development Live Runs", () => {
  it("disables dev live runs and lists all missing probes when results are empty or nil", () => {
    const nilResult = devLiveRunsAllowed(undefined);
    assert.equal(nilResult.allowed, false);
    assert.equal(nilResult.missing.length, 18);
    assert.deepEqual(nilResult.missing, Array.from(DEV_REQUIRED_PROBES));

    const emptyResult = devLiveRunsAllowed({});
    assert.equal(emptyResult.allowed, false);
    assert.equal(emptyResult.missing.length, 18);
  });

  it("enables dev live runs when all 18 dev probes pass", () => {
    const passingRecords: Record<string, boolean> = {};
    for (const id of DEV_REQUIRED_PROBES) {
      passingRecords[id] = true;
    }

    const result = devLiveRunsAllowed(passingRecords);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.missing, []);
  });

  it("enables dev live runs even when production probes (P10, P11, P16, P17) are missing", () => {
    const passingRecords: Record<string, boolean> = {};
    for (const id of DEV_REQUIRED_PROBES) {
      passingRecords[id] = true;
    }
    // Explicitly omit P10, P11, P16, P17
    const result = devLiveRunsAllowed(passingRecords);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.missing, []);
  });

  it("disables dev live runs if any single probe is missing", () => {
    const passingRecords: Record<string, boolean> = {};
    for (const id of DEV_REQUIRED_PROBES) {
      passingRecords[id] = true;
    }
    delete passingRecords["P9"];

    const result = devLiveRunsAllowed(passingRecords);
    assert.equal(result.allowed, false);
    assert.deepEqual(result.missing, ["P9"]);
  });

  it("disables dev live runs if any single probe has failed", () => {
    const passingRecords: Record<string, boolean> = {};
    for (const id of DEV_REQUIRED_PROBES) {
      passingRecords[id] = true;
    }
    passingRecords["P4"] = false;

    const result = devLiveRunsAllowed(passingRecords);
    assert.equal(result.allowed, false);
    assert.deepEqual(result.missing, ["P4"]);
  });

  it("identifies multiple missing or failed probes in order", () => {
    const passingRecords: Record<string, boolean> = {};
    for (const id of DEV_REQUIRED_PROBES) {
      passingRecords[id] = true;
    }
    delete passingRecords["P1"];
    passingRecords["P8"] = false;
    delete passingRecords["S4"];

    const result = devLiveRunsAllowed(passingRecords);
    assert.equal(result.allowed, false);
    assert.deepEqual(result.missing, ["P1", "P8", "S4"]);
  });

  it("works with parseRunsContent output", () => {
    const lines = DEV_REQUIRED_PROBES.map((id) => `| ${id} | pass |`).join("\n");
    const parsed = parseRunsContent(lines);

    const result = devLiveRunsAllowed(parsed);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.missing, []);
  });

  it("handles Map and Array input shapes", () => {
    const map = new Map<string, string>();
    for (const id of DEV_REQUIRED_PROBES) {
      map.set(id, "passed");
    }
    const mapResult = devLiveRunsAllowed(map);
    assert.equal(mapResult.allowed, true);
    assert.deepEqual(mapResult.missing, []);

    const arr = DEV_REQUIRED_PROBES.map((id) => ({ id, passed: true }));
    const arrResult = devLiveRunsAllowed(arr);
    assert.equal(arrResult.allowed, true);
    assert.deepEqual(arrResult.missing, []);
  });
});

describe("Phase 0 Gate: Production Live Runs", () => {
  it("disables prod live runs and lists all missing probes when results are empty or nil", () => {
    const nilResult = prodLiveRunsAllowed(undefined);
    assert.equal(nilResult.allowed, false);
    assert.equal(nilResult.missing.length, 4);
    assert.deepEqual(nilResult.missing, Array.from(PROD_REQUIRED_PROBES));

    const emptyResult = prodLiveRunsAllowed({});
    assert.equal(emptyResult.allowed, false);
    assert.equal(emptyResult.missing.length, 4);
  });

  it("enables prod live runs when all 4 prod probes pass", () => {
    const passingRecords: Record<string, boolean> = {
      P10: true,
      P11: true,
      P16: true,
      P17: true,
    };

    const result = prodLiveRunsAllowed(passingRecords);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.missing, []);
  });

  it("enables prod live runs independently of development probes", () => {
    // Only prod probes provided, dev probes omitted
    const passingRecords: Record<string, { passed: boolean }> = {
      P10: { passed: true },
      P11: { passed: true },
      P16: { passed: true },
      P17: { passed: true },
    };

    const result = prodLiveRunsAllowed(passingRecords);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.missing, []);
  });

  it("disables prod live runs if any production probe is missing", () => {
    const records = {
      P10: true,
      P11: true,
      P16: true,
    };

    const result = prodLiveRunsAllowed(records);
    assert.equal(result.allowed, false);
    assert.deepEqual(result.missing, ["P17"]);
  });

  it("disables prod live runs if any production probe failed", () => {
    const records = {
      P10: "passed",
      P11: "failed",
      P16: "ok",
      P17: "true",
    };

    const result = prodLiveRunsAllowed(records);
    assert.equal(result.allowed, false);
    assert.deepEqual(result.missing, ["P11"]);
  });

  it("works with parseRunsContent output for production probes", () => {
    const lines = [
      "| P10 | pass |",
      "| P11 | ok |",
      "| P16 | success |",
      "| P17 | passed |",
    ].join("\n");
    const parsed = parseRunsContent(lines);

    const result = prodLiveRunsAllowed(parsed);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.missing, []);
  });
});

describe("Phase 0 Gate: fallback-settled probes", () => {
  const rows = (over: Record<string, string>) =>
    DEV_REQUIRED_PROBES.map((id) => `| ${id} | ${over[id] ?? "passed"} |`).join("\n");

  it("accepts a real FAIL (exit code 1) of P4 and P9 as settled by fallback", () => {
    const parsed = parseRunsContent(
      rows({
        P4: "failed (exit code 1)",
        P9: "failed (exit code 1)",
      })
    );
    const result = devLiveRunsAllowed(parsed);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.settledByFallback, ["P4", "P9"]);
  });

  it("settles a real FAIL of P7 by fallback (Kiro loads repo files, they are stripped)", () => {
    const result = devLiveRunsAllowed(parseRunsContent(rows({ P7: "failed (exit code 1)" })));
    assert.equal(result.allowed, true);
    assert.deepEqual(result.settledByFallback, ["P7"]);
  });

  it("does not accept an INCONCLUSIVE (exit code 2) result as settled", () => {
    const result = devLiveRunsAllowed(parseRunsContent(rows({ P9: "failed (exit code 2)" })));
    assert.equal(result.allowed, false);
    assert.deepEqual(result.missing, ["P9"]);
  });

  it("does not settle P2 or P5 by fallback", () => {
    const result = devLiveRunsAllowed(
      parseRunsContent(rows({ P2: "failed (exit code 1)", P5: "failed (exit code 1)" }))
    );
    assert.equal(result.allowed, false);
    assert.deepEqual(result.missing, ["P2", "P5"]);
  });

  it("keeps P12 and S2 strict even after a real FAIL", () => {
    const result = devLiveRunsAllowed(
      parseRunsContent(rows({ P12: "failed (exit code 1)", S2: "failed (exit code 1)" }))
    );
    assert.equal(result.allowed, false);
    assert.deepEqual(result.missing, ["P12", "S2"]);
  });

  it("never settles a probe that was not run", () => {
    const result = devLiveRunsAllowed(parseRunsContent(rows({}).replace("| P4 | passed |", "")));
    assert.deepEqual(result.missing, ["P4"]);
  });

  it("does not settle production probes by fallback", () => {
    const result = prodLiveRunsAllowed(parseRunsContent("| P10 | failed (exit code 1) |"));
    assert.equal(result.allowed, false);
    assert.ok(result.missing.includes("P10"));
  });
});
