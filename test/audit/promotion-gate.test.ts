// WP-29 Tasks 29.1-29.4: offline tests for the promotion gate, audit schema, evidence
// recorder, XR-01/02/03 verifiers and credential rotation checks.
//
// Everything here runs offline (no network, no real credentials). Temp dirs are used for
// evidence; the Kill Switch is exercised against a real in-memory RunStore/EventStore.
import test, { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SettingsStore } from "@/lib/admin/settings-store";
import { RunStore } from "@/lib/runs/run-store";
import { EventStore } from "@/lib/events/event-store";
import {
  KillSwitchService,
  type KillSwitchLevel,
} from "@/lib/admin/kill-switch";
import { GET as promoGet, POST as promoPost } from "@/app/api/admin/promotion-audit/route";
import {
  AUDIT_ITEM_CATALOG,
  AUDIT_ITEM_IDS,
  AUDIT_POST_ITEM_IDS,
  type AuditDocument,
  type AuditItemConclusion,
  buildPassingAuditDocument,
  getItemSpec,
  isAuditDocument,
  requiredItemIdsForPhase,
  validateAuditDocument,
} from "@/lib/audit/audit-schema";
import {
  assertProductionAllowed,
  canIssueProductionCredentials,
  canPublishProductionUrl,
  canSwitchNecromancerToProduction,
  checkProductionReadiness,
  createSignedPromotionAuditRecord,
  evaluatePromotionGate,
} from "@/lib/audit/promotion-gate";
import {
  auditEvidenceDir,
  listEvidenceFiles,
  recordEvidenceItem,
  sanitizeEvidenceItemId,
} from "@/lib/audit/evidence-recorder";
import {
  runXRVerifiers,
  verifyXR01,
  verifyXR02,
  verifyXR03,
  type XR02LevelObservation,
} from "@/lib/audit/xr-verifier";
import {
  defaultPassingItems,
  runSecurityAudit,
} from "../../scripts/audit/run-security-audit";
import {
  fingerprintCredential,
  verifyCredentialRotation,
} from "../../scripts/audit/verify-credentials";

const ADMIN_SECRET = "test-admin-secret-value";
const DATE = "2026-11-28";

let savedEnv: NodeJS.ProcessEnv;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  delete process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_KEY;
});

afterEach(() => {
  process.env = savedEnv;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

function attachStore<T extends Request>(request: T, store: SettingsStore): T {
  (request as unknown as { settingsStore: SettingsStore }).settingsStore = store;
  return request;
}

function adminHeaders(): Record<string, string> {
  return { "x-admin-token": ADMIN_SECRET };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders() },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------------------------
// Task 29.1 — schema catalog & validator
// ---------------------------------------------------------------------------------------------

describe("audit schema catalog (Task 29.1)", () => {
  it("models every C11 block plus the three extension items with severities", () => {
    const blocks = AUDIT_ITEM_CATALOG.filter((spec) => spec.kind === "block").map(
      (spec) => spec.id
    );
    assert.deepEqual(blocks, [
      "CR", "PI", "IS", "NE", "PO", "AD", "LG", "SN", "PR", "RP", "RL", "SC", "KI",
    ]);
    const extensions = AUDIT_ITEM_CATALOG.filter(
      (spec) => spec.kind === "extension"
    ).map((spec) => spec.id);
    assert.deepEqual(extensions, ["XR-01", "XR-02", "XR-03"]);

    for (const id of AUDIT_ITEM_IDS) {
      const spec = getItemSpec(id);
      assert.ok(spec, `expected a catalog spec for ${id}`);
      assert.ok(["A", "B", "C"].includes(spec!.severity));
    }
    // Severity B items exist (they drive the rationale rule).
    const bItems = AUDIT_ITEM_CATALOG.filter((spec) => spec.severity === "B").map(
      (spec) => spec.id
    );
    assert.ok(bItems.length > 0);
    assert.ok(bItems.includes("NE"));
  });

  it("marks RP and RL as post-promotion items required only on G3", () => {
    assert.deepEqual([...AUDIT_POST_ITEM_IDS], ["RP", "RL"]);
    const g1 = requiredItemIdsForPhase("G1");
    const g3 = requiredItemIdsForPhase("G3");
    assert.ok(!g1.includes("RP"));
    assert.ok(!g1.includes("RL"));
    assert.ok(g3.includes("RP"));
    assert.ok(g3.includes("RL"));
    assert.equal(g3.length, g1.length + AUDIT_POST_ITEM_IDS.length);
  });
});

describe("validateAuditDocument (Task 29.1)", () => {
  it("accepts a complete passing G1 document", () => {
    const doc = buildPassingAuditDocument("G1", "owner");
    const result = validateAuditDocument(doc);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.phase, "G1");
  });

  it("rejects an unsigned document", () => {
    const doc = buildPassingAuditDocument("G1", "");
    const result = validateAuditDocument(doc);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "UNSIGNED_DOCUMENT"));
  });

  it("rejects an incomplete document (missing item)", () => {
    const doc = buildPassingAuditDocument("G1", "owner");
    doc.items = doc.items.filter((item) => item.id !== "SC");
    const result = validateAuditDocument(doc);
    assert.equal(result.ok, false);
    const missing = result.errors.find((e) => e.code === "MISSING_ITEM");
    assert.ok(missing);
    assert.equal(missing!.itemId, "SC");
  });

  it("rejects a G3 document that omits a post-promotion item", () => {
    const g1Doc = buildPassingAuditDocument("G1", "owner");
    const asG3: AuditDocument = { ...g1Doc, phase: "G3" };
    const result = validateAuditDocument(asG3);
    assert.equal(result.ok, false);
    const missingIds = result.errors
      .filter((e) => e.code === "MISSING_ITEM")
      .map((e) => e.itemId);
    assert.ok(missingIds.includes("RP"));
    assert.ok(missingIds.includes("RL"));
  });

  it("requires a non-empty rationale for a severity B accepted risk", () => {
    const doc = buildPassingAuditDocument("G1", "owner");
    const ne = doc.items.find((item) => item.id === "NE");
    assert.ok(ne);
    ne!.conclusion = "Accepted risk";
    delete ne!.rationale;
    const missing = validateAuditDocument(doc);
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((e) => e.code === "MISSING_RATIONALE" && e.itemId === "NE"));

    ne!.rationale = "Accepted: compensating control documented in the run record.";
    const withRationale = validateAuditDocument(doc);
    assert.equal(withRationale.ok, true);
  });

  it("rejects an invalid conclusion and a missing owner signature", () => {
    const doc = buildPassingAuditDocument("G1", "owner");
    const cr = doc.items.find((item) => item.id === "CR");
    assert.ok(cr);
    (cr as unknown as { conclusion: string }).conclusion = "Maybe";
    const result = validateAuditDocument(doc);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "INVALID_CONCLUSION"));

    const doc2 = buildPassingAuditDocument("G1", "owner");
    const pi = doc2.items.find((item) => item.id === "PI");
    assert.ok(pi);
    pi!.owner = "   ";
    const result2 = validateAuditDocument(doc2);
    assert.equal(result2.ok, false);
    assert.ok(result2.errors.some((e) => e.code === "MISSING_OWNER_SIGNATURE"));
  });

  it("rejects unknown and duplicate item ids", () => {
    const doc = buildPassingAuditDocument("G1", "owner");
    (doc.items[0] as unknown as { id: string }).id = "ZZ-99";
    const unknown = validateAuditDocument(doc);
    assert.ok(unknown.errors.some((e) => e.code === "UNKNOWN_ITEM"));

    const dup = buildPassingAuditDocument("G1", "owner");
    dup.items.push({ ...dup.items[0] });
    const duplicate = validateAuditDocument(dup);
    assert.ok(duplicate.errors.some((e) => e.code === "DUPLICATE_ITEM"));
  });

  it("rejects non-object / non-document input cleanly", () => {
    assert.equal(validateAuditDocument(null).ok, false);
    assert.equal(validateAuditDocument("nope").ok, false);
    assert.equal(validateAuditDocument({ phase: "G9", actor: "x", items: [] }).ok, false);
    assert.equal(isAuditDocument({ phase: "G1", actor: "x", items: [] }), true);
    assert.equal(isAuditDocument({ phase: "G1", actor: "x" }), false);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 29.1 — promotion gate decisions
// ---------------------------------------------------------------------------------------------

describe("promotion gate (Task 29.1)", () => {
  it("denies every production action without a signed passing G1 record", () => {
    const snapshot = evaluatePromotionGate({ record: null, secret: ADMIN_SECRET });
    assert.equal(snapshot.present, false);
    assert.equal(snapshot.g1Passed, false);
    for (const decision of [
      canIssueProductionCredentials(snapshot),
      canPublishProductionUrl(snapshot),
      canSwitchNecromancerToProduction(snapshot),
    ]) {
      assert.equal(decision.allowed, false);
      assert.equal(decision.code, "G1_AUDIT_REQUIRED");
    }
    const readiness = checkProductionReadiness({ record: null, secret: ADMIN_SECRET });
    assert.equal(readiness.allowed, false);
  });

  it("allows every production action once a signed passing G1 record exists", () => {
    const record = createSignedPromotionAuditRecord({
      actor: "owner",
      status: "passed",
      items: buildPassingAuditDocument("G1", "owner"),
      secret: ADMIN_SECRET,
    });
    const snapshot = evaluatePromotionGate({ record, secret: ADMIN_SECRET });
    assert.equal(snapshot.verified, true);
    assert.equal(snapshot.phase, "G1");
    assert.equal(snapshot.g1Passed, true);
    assert.equal(canIssueProductionCredentials(snapshot).allowed, true);
    assert.equal(canPublishProductionUrl(snapshot).allowed, true);
    assert.equal(canSwitchNecromancerToProduction(snapshot).allowed, true);
    assert.doesNotThrow(() =>
      assertProductionAllowed("switch_necromancer_to_production", snapshot)
    );
  });

  it("refuses a G3 record (post-promotion) for the pre-promotion gate", () => {
    const record = createSignedPromotionAuditRecord({
      actor: "owner",
      status: "passed",
      items: buildPassingAuditDocument("G3", "owner"),
      secret: ADMIN_SECRET,
    });
    const snapshot = evaluatePromotionGate({ record, secret: ADMIN_SECRET });
    assert.equal(snapshot.verified, true);
    assert.equal(snapshot.phase, "G3");
    assert.equal(snapshot.g1Passed, false);
    const decision = canIssueProductionCredentials(snapshot);
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "G1_AUDIT_INVALID");
    assert.throws(
      () => assertProductionAllowed("issue_production_credentials", snapshot),
      /Refused/
    );
  });

  it("treats a tampered record as unverified and denies", () => {
    const record = createSignedPromotionAuditRecord({
      actor: "owner",
      status: "passed",
      items: buildPassingAuditDocument("G1", "owner"),
      secret: ADMIN_SECRET,
    });
    const tampered = { ...record, items: buildPassingAuditDocument("G1", "attacker") };
    const snapshot = evaluatePromotionGate({ record: tampered, secret: ADMIN_SECRET });
    assert.equal(snapshot.verified, false);
    assert.equal(snapshot.g1Passed, false);
    assert.equal(canPublishProductionUrl(snapshot).code, "G1_AUDIT_UNSIGNED");
  });

  it("denies when the admin secret is absent", () => {
    const record = createSignedPromotionAuditRecord({
      actor: "owner",
      status: "passed",
      items: buildPassingAuditDocument("G1", "owner"),
      secret: ADMIN_SECRET,
    });
    const snapshot = evaluatePromotionGate({ record, secret: null });
    assert.equal(snapshot.verified, false);
    assert.equal(snapshot.g1Passed, false);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 29.1 — Admin route integration (backwards compatible)
// ---------------------------------------------------------------------------------------------

describe("promotion-audit route wiring (Task 29.1)", () => {
  it("keeps the legacy {status} POST behaviour (201, verified)", async () => {
    const store = new SettingsStore(":memory:");
    const res = await promoPost(
      attachStore(
        jsonRequest("http://test/api/admin/promotion-audit", { status: "passed" }),
        store
      )
    );
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      verified: boolean;
      record: { status: string; actor: string };
    };
    assert.equal(body.verified, true);
    assert.equal(body.record.status, "passed");
    assert.equal(body.record.actor, "owner");
  });

  it("stores and verifies a valid structured G1 audit and reports gate.g1Passed", async () => {
    const store = new SettingsStore(":memory:");
    const audit = buildPassingAuditDocument("G1", "owner");
    const post = await promoPost(
      attachStore(
        jsonRequest("http://test/api/admin/promotion-audit", { status: "passed", audit }),
        store
      )
    );
    assert.equal(post.status, 201);
    const posted = (await post.json()) as { verified: boolean; record: { items: unknown } };
    assert.equal(posted.verified, true);
    assert.deepEqual(posted.record.items, audit);

    const get = await promoGet(
      attachStore(
        new Request("http://test/api/admin/promotion-audit", { headers: adminHeaders() }),
        store
      )
    );
    assert.equal(get.status, 200);
    const body = (await get.json()) as {
      present: boolean;
      verified: boolean;
      gate: { g1Passed: boolean };
    };
    assert.equal(body.present, true);
    assert.equal(body.verified, true);
    assert.equal(body.gate.g1Passed, true);
  });

  it("rejects an invalid structured audit with 400 and persists nothing", async () => {
    const store = new SettingsStore(":memory:");
    const audit = buildPassingAuditDocument("G1", "owner");
    const ne = audit.items.find((item) => item.id === "NE");
    assert.ok(ne);
    ne!.conclusion = "Accepted risk";
    delete ne!.rationale;

    const res = await promoPost(
      attachStore(
        jsonRequest("http://test/api/admin/promotion-audit", { status: "passed", audit }),
        store
      )
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      errors: Array<{ code: string }>;
    };
    assert.equal(body.ok, false);
    assert.equal(body.error, "audit_validation_failed");
    assert.ok(body.errors.some((e) => e.code === "MISSING_RATIONALE"));
    assert.equal(store.getSetting("promotionAudit"), undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 29.2 — evidence recorder & audit runner
// ---------------------------------------------------------------------------------------------

describe("evidence recorder (Task 29.2)", () => {
  it("writes exactly one file per item id under 01_evidence/audit-<date>", () => {
    const baseDir = makeTempDir("audit-evidence-");
    const r1 = recordEvidenceItem({
      baseDir,
      date: DATE,
      itemId: "CR",
      actor: "owner",
      phase: "G1",
      content: { note: "code review complete" },
    });
    const r2 = recordEvidenceItem({
      baseDir,
      date: DATE,
      itemId: "XR-01",
      actor: "owner",
      phase: "G1",
      content: { note: "sandboxes destroyed" },
    });
    assert.equal(r1.filename, "CR.json");
    assert.equal(r2.filename, "XR-01.json");
    assert.ok(r1.path.startsWith(auditEvidenceDir(baseDir, DATE)));

    const files = listEvidenceFiles(baseDir, DATE);
    assert.deepEqual(files, ["CR.json", "XR-01.json"]);

    // Re-recording the same id overwrites in place (still one file per id).
    recordEvidenceItem({ baseDir, date: DATE, itemId: "CR", content: "again" });
    assert.deepEqual(listEvidenceFiles(baseDir, DATE), ["CR.json", "XR-01.json"]);
  });

  it("redacts secret-like values before writing to disk", () => {
    const baseDir = makeTempDir("audit-redact-");
    const secret = `ghp_${"a".repeat(36)}`;
    const result = recordEvidenceItem({
      baseDir,
      date: DATE,
      itemId: "SC",
      content: `leaked token ${secret} in evidence`,
    });
    assert.equal(result.redacted, true);
    const onDisk = fs.readFileSync(result.path, "utf8");
    assert.ok(!onDisk.includes(secret));
    assert.ok(onDisk.includes("[REDACTED]"));
  });

  it("refuses path-traversal item ids and never writes outside the audit dir", () => {
    const baseDir = makeTempDir("audit-traversal-");
    assert.throws(() => sanitizeEvidenceItemId("../escape"));
    assert.throws(() => sanitizeEvidenceItemId("a/b"));
    assert.throws(() =>
      recordEvidenceItem({ baseDir, date: DATE, itemId: "..", content: "x" })
    );
    // Nothing escaped the workspace.
    assert.equal(fs.existsSync(path.join(baseDir, "escape.json")), false);
    assert.deepEqual(listEvidenceFiles(baseDir, DATE), []);
  });
});

describe("runSecurityAudit (Task 29.2)", () => {
  it("runs a passing G1 audit and records one evidence file per item", () => {
    const baseDir = makeTempDir("audit-run-g1-");
    const result = runSecurityAudit({
      phase: "G1",
      baseDir,
      actor: "owner",
      date: DATE,
      items: defaultPassingItems("G1", "owner"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.privacy, null);
    const expected = requiredItemIdsForPhase("G1").length;
    assert.equal(result.recorded.length, expected);
    assert.equal(listEvidenceFiles(baseDir, DATE).length, expected);
  });

  it("rejects a G3 audit with no attached privacy report", () => {
    const baseDir = makeTempDir("audit-run-g3-");
    const result = runSecurityAudit({
      phase: "G3",
      baseDir,
      actor: "owner",
      date: DATE,
      items: defaultPassingItems("G3", "owner"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.privacy, { required: true, attached: false, clean: false });
  });

  it("passes a G3 audit with a clean attached privacy report", () => {
    const baseDir = makeTempDir("audit-run-g3-ok-");
    const result = runSecurityAudit({
      phase: "G3",
      baseDir,
      actor: "owner",
      date: DATE,
      items: defaultPassingItems("G3", "owner"),
      privacyScan: { attached: true, clean: true, reportPath: "privacy.json" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.privacy, { required: true, attached: true, clean: true });
    assert.equal(
      listEvidenceFiles(baseDir, DATE).length,
      requiredItemIdsForPhase("G3").length
    );
  });

  it("rejects a G3 audit that omits the post-promotion items", () => {
    const baseDir = makeTempDir("audit-run-g3-missing-");
    const result = runSecurityAudit({
      phase: "G3",
      baseDir,
      actor: "owner",
      date: DATE,
      items: defaultPassingItems("G1", "owner"),
      privacyScan: { attached: true, clean: true },
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.validation.errors.some(
        (e) => e.code === "MISSING_ITEM" && (e.itemId === "RP" || e.itemId === "RL")
      )
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Task 29.3 — XR-01 / XR-02 / XR-03 verifiers
// ---------------------------------------------------------------------------------------------

function makeKillSwitchStores(): {
  db: DatabaseSync;
  runStore: RunStore;
  eventStore: EventStore;
} {
  const db = new DatabaseSync(":memory:");
  return { db, runStore: new RunStore(db), eventStore: new EventStore(db) };
}

describe("XR verifiers (Task 29.3)", () => {
  it("XR-01 passes when every sandbox is destroyed with no residual state", () => {
    const ok = verifyXR01({
      sandboxes: [
        { runId: "run-1", sandboxId: "box-1", destroyed: true },
        { runId: "run-2", sandboxId: "box-2", destroyed: true },
      ],
      residualWorktrees: [],
      residualSandboxes: [],
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.id, "XR-01");
  });

  it("XR-01 fails when a sandbox survives or residual state carries over", () => {
    const notDestroyed = verifyXR01({
      sandboxes: [{ runId: "run-1", sandboxId: "box-1", destroyed: false }],
    });
    assert.equal(notDestroyed.ok, false);

    const residual = verifyXR01({
      sandboxes: [{ runId: "run-1", sandboxId: "box-1", destroyed: true }],
      residualWorktrees: ["/tmp/worktree-run-1"],
    });
    assert.equal(residual.ok, false);
    assert.ok(residual.failures.some((f) => f.includes("Residual worktree")));
  });

  it("XR-02 passes against a real Kill Switch across all three levels", async () => {
    const { db, runStore, eventStore } = makeKillSwitchStores();
    try {
      runStore.createRun({
        runId: "active-1",
        url: "https://example.test/a/b",
        sha: "1".repeat(40),
        phase: "legion",
      });
      runStore.createRun({
        runId: "queued-1",
        url: "https://example.test/a/b",
        sha: "2".repeat(40),
        phase: "queued",
      });

      const service = new KillSwitchService({
        runStore,
        eventStore,
        runtimeControls: {
          pauseAdmission: () => {},
          pauseHost: () => {},
          stopRunGracefully: () => {},
          killRun: () => {},
          removeQueuedRun: () => true,
        },
      });

      const observations: XR02LevelObservation[] = [];

      const pauseRes = service.execute("pause_new_runs", { actor: "owner" });
      observations.push({
        level: "pause_new_runs",
        executed: true,
        pausedNewRuns: service.isPausedNewRuns(),
        stoppingGracefully: service.isStoppingGracefully(),
        affectedCount: pauseRes.affectedRunCount,
        killedCount: 0,
        queuedPreserved: runStore.getRun("queued-1")?.phase === "queued",
      });

      const stopRes = service.execute("stop_gracefully", { actor: "owner" });
      observations.push({
        level: "stop_gracefully",
        executed: true,
        pausedNewRuns: service.isPausedNewRuns(),
        stoppingGracefully: service.isStoppingGracefully(),
        affectedCount: stopRes.affectedRunCount,
        killedCount: 0,
        queuedPreserved: runStore.getRun("queued-1")?.phase === "queued",
      });

      const killRes = service.execute("hard_kill", { actor: "owner" });
      if (killRes.waitForRuntime) {
        await killRes.waitForRuntime();
      }
      const killedCount = killRes.affectedRunIds.filter(
        (id) => runStore.getRun(id)?.outcome === "killed"
      ).length;
      observations.push({
        level: "hard_kill",
        executed: true,
        pausedNewRuns: service.isPausedNewRuns(),
        stoppingGracefully: service.isStoppingGracefully(),
        affectedCount: killRes.affectedRunCount,
        killedCount,
        queuedPreserved: true,
      });

      const verdict = verifyXR02({ observations });
      assert.equal(verdict.ok, true, verdict.failures.join("; "));
      assert.equal((verdict.details.levelsExercised as unknown[]).length, 3);
    } finally {
      db.close();
    }
  });

  it("XR-02 fails when a level is missing or a hard kill is incomplete", () => {
    const missing = verifyXR02({
      observations: [
        {
          level: "pause_new_runs",
          executed: true,
          pausedNewRuns: true,
          stoppingGracefully: false,
          affectedCount: 1,
          killedCount: 0,
          queuedPreserved: true,
        },
      ],
    });
    assert.equal(missing.ok, false);

    const incomplete = verifyXR02({
      observations: [
        {
          level: "pause_new_runs",
          executed: true,
          pausedNewRuns: true,
          stoppingGracefully: false,
          affectedCount: 1,
          killedCount: 0,
          queuedPreserved: true,
        },
        {
          level: "stop_gracefully",
          executed: true,
          pausedNewRuns: true,
          stoppingGracefully: true,
          affectedCount: 1,
          killedCount: 0,
          queuedPreserved: true,
        },
        {
          level: "hard_kill",
          executed: true,
          pausedNewRuns: true,
          stoppingGracefully: true,
          affectedCount: 2,
          killedCount: 1,
          queuedPreserved: true,
        },
      ],
    });
    assert.equal(incomplete.ok, false);
    assert.ok(incomplete.failures.some((f) => f.includes("hard_kill killed")));
  });

  it("XR-03 passes only when every non-fork push and source write is refused", () => {
    const ok = verifyXR03({
      attempts: [
        { kind: "push", target: "https://github.com/other/repo", isFork: false, isSource: false, refused: true, code: "WRITE_PROHIBITED" },
        { kind: "push", target: "https://github.com/owner/fork", isFork: true, isSource: false, refused: false },
        { kind: "write", target: "https://github.com/owner/source", isFork: false, isSource: true, refused: true, code: "WRITE_PROHIBITED" },
      ],
    });
    assert.equal(ok.ok, true);

    const notRefused = verifyXR03({
      attempts: [
        { kind: "push", target: "https://github.com/other/repo", isFork: false, isSource: false, refused: false },
        { kind: "write", target: "https://github.com/owner/source", isFork: false, isSource: true, refused: true },
      ],
    });
    assert.equal(notRefused.ok, false);

    const noCoverage = verifyXR03({ attempts: [] });
    assert.equal(noCoverage.ok, false);
  });

  it("runXRVerifiers aggregates the three verdicts", () => {
    const result = runXRVerifiers({
      xr01: { sandboxes: [{ runId: "r", sandboxId: "b", destroyed: true }] },
      xr02: {
        observations: [
          { level: "pause_new_runs", executed: true, pausedNewRuns: true, stoppingGracefully: false, affectedCount: 0, killedCount: 0, queuedPreserved: true },
          { level: "stop_gracefully", executed: true, pausedNewRuns: true, stoppingGracefully: true, affectedCount: 0, killedCount: 0, queuedPreserved: true },
          { level: "hard_kill", executed: true, pausedNewRuns: true, stoppingGracefully: true, affectedCount: 0, killedCount: 0, queuedPreserved: true },
        ],
      },
      xr03: {
        attempts: [
          { kind: "push", target: "x", isFork: false, isSource: false, refused: true },
          { kind: "write", target: "y", isFork: false, isSource: true, refused: true },
        ],
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.verdicts.length, 3);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 29.4 — credential rotation & dev revocation
// ---------------------------------------------------------------------------------------------

describe("credential rotation verifier (Task 29.4)", () => {
  it("passes when every production credential is fresh, distinct and revoked dev creds fail", () => {
    const result = verifyCredentialRotation({
      pairs: [
        { name: "kiro_key", dev: "dev-kiro-111", prod: "prod-kiro-222" },
        { name: "sandbox_key", dev: "dev-sandbox-aaa", prod: "prod-sandbox-bbb" },
        { name: "invite_codes", dev: "gg_dev_invite", prod: "gg_prod_invite" },
        { name: "github_token", dev: "ghp_dev_0123456789", prod: "ghp_prod_9876543210" },
      ],
      revokedCredentials: [
        { name: "kiro_key", credential: "dev-kiro-111" },
        { name: "github_token", credential: "ghp_dev_0123456789" },
      ],
      revokedProbes: [
        { name: "sandbox_key", devCredential: "dev-sandbox-aaa", authProbe: () => false },
      ],
    });
    assert.equal(result.ok, true, result.failures.join("; "));
    assert.equal(result.fingerprints.length, 4);
    assert.ok(result.fingerprints.every((fp) => fp.distinct && fp.fresh));
    assert.ok(result.revoked.every((entry) => entry.rejected));
  });

  it("fails when a production credential is identical to its development value", () => {
    const result = verifyCredentialRotation({
      pairs: [{ name: "kiro_key", dev: "same-value", prod: "same-value" }],
      revokedCredentials: [{ name: "kiro_key", credential: "same-value" }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.fingerprints[0].distinct === false);
    assert.ok(result.failures.some((f) => f.includes("not distinct")));
  });

  it("fails when a revoked dev credential still authenticates", () => {
    const result = verifyCredentialRotation({
      pairs: [{ name: "kiro_key", dev: "dev-kiro-111", prod: "prod-kiro-222" }],
      revokedProbes: [
        { name: "kiro_key", devCredential: "dev-kiro-111", authProbe: () => true },
      ],
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("still authenticates")));
  });

  it("never surfaces raw credential strings — only SHA-256 fingerprints", () => {
    const dev = "dev-kiro-secret-abcdef";
    const prod = "prod-kiro-secret-123456";
    const result = verifyCredentialRotation({
      pairs: [{ name: "kiro_key", dev, prod }],
      revokedCredentials: [{ name: "kiro_key", credential: dev }],
    });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(dev));
    assert.ok(!serialized.includes(prod));
    const fp = result.fingerprints[0];
    assert.equal(fp.devFingerprint, fingerprintCredential(dev));
    assert.equal(fp.prodFingerprint, fingerprintCredential(prod));
    assert.notEqual(fp.devFingerprint, dev);
    assert.match(fp.prodFingerprint, /^[0-9a-f]{64}$/);
  });
});