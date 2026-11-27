import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  loadBuildEvidence,
  fetchRecentKiroRuns,
  mapHistoryRun,
  loadEvidenceBundle,
  type KiroEvidenceDoc,
  type PublishedRunEvidence,
} from "@/lib/evidence/evidence-service";
import { BuiltWithKiroEvidence } from "@/components/BuiltWithKiroEvidence";
import {
  buildKiroHandoff,
  formatKiroHandoffText,
} from "@/lib/artifacts/kiro-handoff";
import { OpenInKiroHandoff } from "@/components/OpenInKiroHandoff";

const REPO_ROOT = process.cwd();

function sampleBuild(overrides: Partial<KiroEvidenceDoc> = {}): KiroEvidenceDoc {
  return {
    schemaVersion: "v1",
    generatedFromSha: "abc1234",
    specs: [{ path: ".kiro/specs/resurrection-engine/design.md", name: "resurrection-engine" }],
    steering: [
      { path: ".kiro/steering/product.md", name: "product", inclusion: "always" },
    ],
    hooks: [
      { name: "rules-props", trigger: "PostFileSave", command: "npm run test:props" },
    ],
    agents: [
      {
        path: "lib/agents/templates/planner.md",
        name: "planner",
        description: "Planner Skeleton",
        tools: ["read", "write"],
        excludedTools: ["shell"],
        permissions: [{ capability: "shell", effect: "deny" }],
      },
    ],
    commitLinks: [
      { sha: "abc1234def", shortSha: "abc1234", subject: "feat: thing", refs: "" },
    ],
    ...overrides,
  };
}

describe("Task 26.3: evidence-service loader", () => {
  it("loads the committed build evidence from disk", async () => {
    const doc = await loadBuildEvidence(REPO_ROOT);
    assert.equal(doc.schemaVersion, "v1");
    assert.ok(Array.isArray(doc.specs) && doc.specs.length > 0);
    assert.ok(Array.isArray(doc.steering) && doc.steering.length > 0);
    assert.ok(Array.isArray(doc.hooks));
    assert.ok(Array.isArray(doc.agents) && doc.agents.length > 0);
    // Every referenced path must exist and be relative.
    for (const p of [...doc.specs, ...doc.steering, ...doc.agents].map((e) => e.path)) {
      assert.ok(!path.isAbsolute(p));
      assert.ok(!p.includes(".."));
      assert.ok(fs.existsSync(path.join(REPO_ROOT, p)), `missing ${p}`);
    }
  });

  it("returns an empty-but-valid doc when the file is missing", async () => {
    const doc = await loadBuildEvidence("/nonexistent-root-xyz");
    assert.equal(doc.specs.length, 0);
    assert.equal(doc.agents.length, 0);
  });

  it("maps a raw history run into skeleton records", () => {
    const mapped = mapHistoryRun({
      runId: "run-1",
      repository: "owner/repo",
      outcome: "resurrected",
      date: "2026-01-01T00:00:00.000Z",
      skeletons: [
        {
          role: "builder",
          agentName: "soul-stitcher",
          modelId: "claude-sonnet-5.5",
          kiroCliVersion: "3.1.0",
          sessionId: "sess-1",
          timestamp: 1700000000000,
        },
      ],
    });
    assert.equal(mapped.runId, "run-1");
    assert.equal(mapped.skeletons.length, 1);
    assert.equal(mapped.skeletons[0].role, "builder");
    assert.equal(mapped.skeletons[0].kiroCliVersion, "3.1.0");
  });

  it("fetches the three most recent published runs via a stub fetch", async () => {
    const calls: string[] = [];
    const stub = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return {
        ok: true,
        json: async () => [
          { runId: "r1", skeletons: [] },
          { runId: "r2", skeletons: [] },
          { runId: "r3", skeletons: [] },
          { runId: "r4", skeletons: [] },
        ],
      } as Response;
    }) as unknown as typeof fetch;
    const runs = await fetchRecentKiroRuns(3, stub);
    assert.equal(runs.length, 3);
    assert.ok(calls[0].includes("/api/history?fields=kiro"));
  });

  it("returns [] from fetchRecentKiroRuns when fetch is unavailable", async () => {
    const runs = await fetchRecentKiroRuns(3, undefined);
    assert.deepEqual(runs, []);
  });

  it("loadEvidenceBundle merges build + recent runs", async () => {
    const stub = (async () =>
      ({ ok: true, json: async () => [{ runId: "r1", skeletons: [] }] }) as Response) as unknown as typeof fetch;
    const bundle = await loadEvidenceBundle(REPO_ROOT, stub);
    assert.ok(bundle.build.specs.length > 0);
    assert.equal(bundle.recentRuns.length, 1);
  });
});

describe("Task 26.3: BuiltWithKiroEvidence component", () => {
  it("renders build-time sections and runtime runs", () => {
    const runs: PublishedRunEvidence[] = [
      {
        runId: "run-1",
        repository: "owner/repo",
        outcome: "resurrected",
        date: "2026-01-01T00:00:00.000Z",
        skeletons: [
          {
            role: "builder",
            agentName: "soul-stitcher",
            modelId: "claude-sonnet-5.5",
            kiroCliVersion: "3.1.0",
            sessionId: "sess-1",
            timestamp: 1700000000000,
          },
        ],
      },
    ];
    const html = renderToStaticMarkup(
      React.createElement(BuiltWithKiroEvidence, { build: sampleBuild(), recentRuns: runs })
    );
    assert.ok(html.includes("resurrection-engine"));
    assert.ok(html.includes("inclusion:"));
    assert.ok(html.includes("rules-props"));
    assert.ok(html.includes("planner"));
    assert.ok(html.includes("soul-stitcher"));
    assert.ok(html.includes("3.1.0"));
  });

  it("shows 'None found' for empty sections", () => {
    const empty: KiroEvidenceDoc = {
      schemaVersion: "v1",
      generatedFromSha: "",
      specs: [],
      steering: [],
      hooks: [],
      agents: [],
      commitLinks: [],
    };
    const html = renderToStaticMarkup(
      React.createElement(BuiltWithKiroEvidence, { build: empty, recentRuns: [] })
    );
    assert.ok(html.includes("None found"));
  });

  it("includes the 'What does not use Kiro' section", () => {
    const html = renderToStaticMarkup(
      React.createElement(BuiltWithKiroEvidence, { build: sampleBuild(), recentRuns: [] })
    );
    assert.ok(html.includes("What does not use Kiro"));
    assert.ok(html.includes("Grimoire"));
  });
});

describe("Task 26.4: kiro-handoff builder", () => {
  it("builds clone/apply/copy/verify steps with sanitized inputs", () => {
    const plan = buildKiroHandoff({
      owner: "test-owner",
      repo: "test-repo",
      baseSha: "abc1234def",
      runId: "run-1",
    });
    assert.equal(plan.owner, "test-owner");
    assert.equal(plan.repo, "test-repo");
    assert.equal(plan.specCopyTarget, ".kiro/specs/resurrection/test-owner-test-repo/");
    assert.equal(plan.specCopyFallback, ".kiro/specs/test-owner-test-repo/");
    const allCommands = plan.steps.flatMap((s) => s.commands);
    assert.ok(allCommands.includes("git apply -p1 all.patch"));
    assert.ok(allCommands.includes("git checkout abc1234def"));
  });

  it("sanitizes malicious owner/repo inputs", () => {
    const plan = buildKiroHandoff({
      owner: "../../etc",
      repo: "repo; rm -rf /",
      baseSha: "not-a-sha",
      runId: "run/../x",
    });
    assert.ok(!plan.owner.includes("/"));
    assert.ok(!plan.repo.includes(";"));
    assert.ok(!plan.runId.includes("/"));
    assert.equal(plan.baseSha, "BASE_SHA");
  });

  it("formats a copy-friendly plain-text block with the fallback note", () => {
    const plan = buildKiroHandoff({
      owner: "o",
      repo: "r",
      baseSha: "abc1234",
      runId: "run-1",
    });
    const text = formatKiroHandoffText(plan);
    assert.ok(text.includes("git apply -p1 all.patch"));
    assert.ok(text.includes(".kiro/specs/resurrection/o-r/"));
    assert.ok(text.includes("Fallback") || text.includes("fallback"));
  });

  it("explains extracting the bundle and copying all.patch and spec/ into the clone", () => {
    const plan = buildKiroHandoff({
      owner: "o",
      repo: "r",
      baseSha: "abc1234",
      runId: "run-1",
    });
    const allCommands = plan.steps.flatMap((s) => s.commands);
    const applyIndex = allCommands.indexOf("git apply -p1 all.patch");
    const copyIndex = allCommands.findIndex(
      (c) => c.startsWith("cp") && c.includes("all.patch") && c.includes("spec")
    );
    assert.ok(applyIndex >= 0, "must keep the literal git apply command");
    assert.ok(copyIndex >= 0, "must copy all.patch and spec/ into the clone");
    assert.ok(copyIndex < applyIndex, "bundle files must be copied before applying the patch");

    const detail = plan.steps.map((s) => s.detail).join(" ");
    assert.match(detail, /BUNDLE_DIR/);
    assert.match(detail, /extract/i);
    assert.match(detail, /all\.patch/);
    assert.match(detail, /spec\//);
  });
});

describe("Task 26.4: OpenInKiroHandoff component", () => {
  it("renders the handoff steps and copy target (SSR-safe)", () => {
    const html = renderToStaticMarkup(
      React.createElement(OpenInKiroHandoff, {
        owner: "test-owner",
        repo: "test-repo",
        baseSha: "abc1234def",
        runId: "run-kiro-handoff",
      })
    );
    assert.ok(html.includes("Open in Kiro Handoff Instructions"));
    assert.ok(html.includes("git apply -p1 all.patch"));
    assert.ok(html.includes(".kiro/specs/resurrection/test-owner-test-repo/"));
  });
});