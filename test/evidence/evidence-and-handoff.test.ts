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
  deriveVerificationCommands,
  formatKiroHandoffText,
  type KiroHandoffCertificate,
} from "@/lib/artifacts/kiro-handoff";
import { OpenInKiroHandoff } from "@/components/OpenInKiroHandoff";
import { ReliquaryView } from "@/components/ReliquaryView";
import type { BeforeAfterRowData } from "@/components/ReliquaryBeforeAfterTable";

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

  it("honors an explicit baseUrl (trimming trailing slashes) when fetching recent runs", async () => {
    const calls: string[] = [];
    const stub = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return {
        ok: true,
        json: async () => [{ runId: "r1", skeletons: [] }],
      } as Response;
    }) as unknown as typeof fetch;
    await fetchRecentKiroRuns(3, stub, "https://example.test/");
    assert.equal(calls[0], "https://example.test/api/history?fields=kiro&limit=3");
  });

  it("maps a skeleton without a numeric timestamp to 0 even when the run has createdAt", () => {
    const mapped = mapHistoryRun({
      runId: "run-no-ts",
      createdAt: 1700000000000,
      skeletons: [{ role: "builder", agentName: "soul-stitcher" }],
    });
    assert.equal(mapped.skeletons[0].timestamp, 0);
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

  it("copies the downloaded all.patch before applying it and never assumes a tar.gz archive", () => {
    const plan = buildKiroHandoff({
      owner: "o",
      repo: "r",
      baseSha: "abc1234",
      runId: "run-1",
    });
    const allCommands = plan.steps.flatMap((s) => s.commands);
    const text = formatKiroHandoffText(plan);
    // The Reliquary download endpoint serves individual files, not a .tar.gz bundle.
    assert.ok(!text.includes(".tar.gz"));

    const applyIndex = allCommands.indexOf("git apply -p1 all.patch");
    const copyIndex = allCommands.findIndex(
      (c) => c.startsWith("cp") && c.includes("all.patch")
    );
    assert.ok(applyIndex >= 0, "must keep the literal git apply command");
    assert.ok(copyIndex >= 0, "must copy the downloaded all.patch into the clone");
    assert.ok(copyIndex < applyIndex, "all.patch must be copied before applying the patch");

    const detail = plan.steps.map((s) => s.detail).join(" ");
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

describe("Task 26.4: ReliquaryView Open in Kiro handoff gating", () => {
  it("renders the handoff when owner, repo and baseSha are provided", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReliquaryView, {
        runId: "run-kiro-handoff",
        owner: "octocat",
        repo: "repo",
        baseSha: "abc1234",
      })
    );
    assert.ok(html.includes('data-testid="open-in-kiro-handoff"'));
    assert.ok(html.includes("git apply -p1 all.patch"));
    assert.ok(!html.includes('data-testid="open-in-kiro-unavailable"'));
  });

  it("renders the handoff when owner and repo are provided without baseSha", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReliquaryView, {
        runId: "r-x",
        owner: "test-owner",
        repo: "test-repo",
      })
    );
    assert.ok(html.includes('data-testid="open-in-kiro-handoff"'));
    assert.ok(html.includes("git apply -p1 all.patch"));
    assert.ok(html.includes(".kiro/specs/resurrection/test-owner-test-repo/"));
    assert.ok(!html.includes('data-testid="open-in-kiro-unavailable"'));
  });

  it("renders the honest unavailable notice when owner and repo are omitted", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReliquaryView, {
        runId: "r-empty",
        outcome: "partial",
      })
    );
    assert.ok(html.includes('data-testid="open-in-kiro-unavailable"'));
    assert.ok(!html.includes('data-testid="open-in-kiro-handoff"'));
  });
  it("merges owner from props with repo from initialEvents into a real handoff target", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReliquaryView, {
        runId: "run-mixed",
        owner: "octocat",
        initialEvents: [
          {
            runId: "run-mixed",
            seq: 1,
            ts: 1731672000000,
            kind: "exhume.certificate",
            actor: "exhumer",
            data: { repo: "project", refs: [] },
          },
        ],
      })
    );
    assert.ok(html.includes('data-testid="open-in-kiro-handoff"'));
    assert.ok(html.includes("https://github.com/octocat/project.git"));
    assert.ok(!html.includes('data-testid="open-in-kiro-unavailable"'));
  });
});

describe("Open in Kiro handoff: verification commands follow the recorded certificate", () => {
  const RESUME_TITLE = "Resume development locally with the Kiro CLI";
  const VERIFY_TITLE = "Verify locally in your shell";

  function resumeCommands(plan: ReturnType<typeof buildKiroHandoff>): string[] {
    const step = plan.steps.find((s) => s.title === RESUME_TITLE);
    assert.ok(step, "resume step must exist");
    return step!.commands;
  }

  function verifyCommands(plan: ReturnType<typeof buildKiroHandoff>): string[] {
    const step = plan.steps.find((s) => s.title === VERIFY_TITLE);
    return step ? step.commands : [];
  }

  it("emits the recorded python install and test commands and omits the build", () => {
    const certificate: KiroHandoffCertificate = {
      primaryLanguage: "python",
      packageManager: "pip",
      install: { step: "install", command: "pip install -r requirements.txt", status: "passed" },
      build: { step: "build", command: "not run", status: "not run" },
      test: { step: "test", command: "pytest", status: "passed" },
      rows: [
        { step: "install", command: "pip install -r requirements.txt", status: "passed" },
        { step: "build", command: "not run", status: "not run" },
        { step: "test", command: "pytest", status: "passed" },
      ],
    };

    const plan = buildKiroHandoff({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-py",
      certificate,
    });

    // REPL step stays limited to launching the CLI and running the spec.
    const repl = resumeCommands(plan);
    assert.deepEqual(repl, ["kiro-cli", "/spec run resurrection"]);

    // Shell verification commands live in their own step, never in the REPL.
    const commands = verifyCommands(plan);
    assert.ok(commands.includes("pip install -r requirements.txt"));
    assert.ok(commands.includes("pytest"));
    // The build was recorded as "not run", so no build command may appear.
    assert.equal(commands.filter((c) => /build/i.test(c)).length, 0);
    // No placeholder npm commands for a python run.
    assert.ok(!commands.some((c) => c.includes("npm")));

    const text = formatKiroHandoffText(plan);
    assert.ok(!text.includes("npm"));
    assert.ok(text.includes(VERIFY_TITLE));

    const verifyStep = plan.steps.find((s) => s.title === VERIFY_TITLE);
    assert.match(verifyStep!.detail, /in your own shell/);
  });

  it("omits pytest and the build when no tests were found", () => {
    const certificate: KiroHandoffCertificate = {
      primaryLanguage: "python",
      packageManager: "pip",
      install: { step: "install", command: "pip install -r requirements.txt", status: "passed" },
      build: { step: "build", command: "not run", status: "not run" },
      test: { step: "test", command: "pytest", status: "No tests found", noTestsFound: true },
    };

    const commands = deriveVerificationCommands({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-py-notests",
      certificate,
    });

    assert.deepEqual(commands, ["pip install -r requirements.txt"]);
    assert.ok(!commands.includes("pytest"));
    assert.equal(commands.filter((c) => /build/i.test(c)).length, 0);
  });

  it("emits all three exact node commands when they were recorded", () => {
    const certificate: KiroHandoffCertificate = {
      primaryLanguage: "node",
      packageManager: "npm",
      install: { step: "install", command: "npm ci", status: "passed" },
      build: { step: "build", command: "npm run build", status: "passed" },
      test: { step: "test", command: "npm test", status: "passed" },
    };

    const commands = deriveVerificationCommands({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-node",
      certificate,
    });

    assert.deepEqual(commands, ["npm ci", "npm run build", "npm test"]);
  });

  it("does not inject unrecorded npm commands when no certificate is supplied", () => {
    const plan = buildKiroHandoff({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-no-cert",
    });

    const commands = resumeCommands(plan);
    assert.ok(!commands.includes("npm install"));
    assert.ok(!commands.includes("npm run build"));
    assert.ok(!commands.includes("npm test"));
    // Only the CLI invocation and spec run remain.
    assert.deepEqual(commands, ["kiro-cli", "/spec run resurrection"]);
    // No certificate means no shell verification step is appended.
    assert.equal(verifyCommands(plan).length, 0);
    assert.ok(!plan.steps.some((s) => s.title === VERIFY_TITLE));

    const text = formatKiroHandoffText(plan);
    assert.ok(!text.includes("npm install"));
    assert.ok(!text.includes("npm run build"));
    assert.ok(!text.includes("npm test"));
  });

  it("prefers the recorded retry command when the first install failed", () => {
    const certificate: KiroHandoffCertificate = {
      primaryLanguage: "python",
      packageManager: "pip",
      install: { step: "install", command: "pip install -r requirements.txt", status: "failed" },
      retry: {
        step: "retry",
        command: "pip install --prefer-offline -r requirements.txt",
        status: "passed",
      },
      build: { step: "build", command: "not run", status: "not run" },
      test: { step: "test", command: "pytest", status: "passed" },
    };

    const commands = deriveVerificationCommands({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-retry",
      certificate,
    });

    assert.deepEqual(commands, [
      "pip install --prefer-offline -r requirements.txt",
      "pytest",
    ]);
  });

  it("returns the explicit verificationCommands verbatim (deduplicated) when supplied", () => {
    const commands = deriveVerificationCommands({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-explicit",
      verificationCommands: ["make test", "make test", "make lint"],
    });
    assert.deepEqual(commands, ["make test", "make lint"]);
  });

  it("returns no commands when neither a certificate nor verification commands are supplied", () => {
    const commands = deriveVerificationCommands({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-empty",
    });
    assert.deepEqual(commands, []);
  });

  it("passes recorded python commands from events through ReliquaryView to the handoff", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReliquaryView, {
        runId: "run-py-events",
        initialEvents: [
          {
            runId: "run-py-events",
            seq: 1,
            ts: 1731672000000,
            kind: "exhume.certificate",
            actor: "exhumer",
            data: {
              owner: "octocat",
              repo: "legacy",
              baseSha: "abc1234def",
              primaryLanguage: "python",
              packageManager: "pip",
              refs: [],
            },
          },
          {
            runId: "run-py-events",
            seq: 2,
            ts: 1731672000001,
            kind: "command.result",
            actor: "exhumer",
            data: {
              step: "install",
              commandLine: "pip install -r requirements.txt",
              status: "passed",
              refs: [],
            },
          },
          {
            runId: "run-py-events",
            seq: 3,
            ts: 1731672000002,
            kind: "command.result",
            actor: "exhumer",
            data: { step: "build", commandLine: "not run", status: "not run", refs: [] },
          },
          {
            runId: "run-py-events",
            seq: 4,
            ts: 1731672000003,
            kind: "command.result",
            actor: "exhumer",
            data: { step: "test", commandLine: "pytest", status: "passed", refs: [] },
          },
        ],
      })
    );

    assert.ok(html.includes('data-testid="open-in-kiro-handoff"'));
    assert.ok(html.includes("pip install -r requirements.txt"));
    assert.ok(html.includes("pytest"));
    assert.ok(!html.includes("npm"));
  });
});

describe("Open in Kiro handoff: argv quoting and whitespace preservation", () => {
  it("shell-quotes argv elements with spaces and preserves empty argv elements", () => {
    const withSpace = deriveVerificationCommands({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-argv-space",
      certificate: {
        test: { step: "test", command: ["pytest", "tests/a b.py"], status: "passed" },
      },
    });
    assert.deepEqual(withSpace, ["pytest 'tests/a b.py'"]);

    const withEmpty = deriveVerificationCommands({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-argv-empty",
      certificate: {
        test: { step: "test", command: ["pytest", ""], status: "passed" },
      },
    });
    assert.deepEqual(withEmpty, ["pytest ''"]);
  });

  it("preserves internal whitespace verbatim in string commands", () => {
    const commands = deriveVerificationCommands({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-ws",
      certificate: {
        test: { step: "test", command: 'python -c "print(\'a  b\')"', status: "passed" },
      },
    });
    assert.deepEqual(commands, ['python -c "print(\'a  b\')"']);
    assert.ok(commands[0].includes("a  b"), "double space inside the string must survive");
  });
});

describe("Open in Kiro handoff: no fabricated language defaults", () => {
  it("emits only kiro-cli and the spec run when only language metadata is recorded", () => {
    const certificate: KiroHandoffCertificate = {
      primaryLanguage: "python",
      packageManager: "pip",
    };

    const commands = deriveVerificationCommands({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-lang-only",
      certificate,
    });
    assert.deepEqual(commands, []);

    const plan = buildKiroHandoff({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-lang-only",
      certificate,
    });
    const resume = plan.steps.find(
      (s) => s.title === "Resume development locally with the Kiro CLI"
    );
    assert.ok(resume, "resume step must exist");
    assert.deepEqual(resume!.commands, ["kiro-cli", "/spec run resurrection"]);
  });
});

describe("ReliquaryView Open in Kiro handoff: pure before/after derivation", () => {
  const buildNotRunRows: BeforeAfterRowData[] = [
    {
      label: "Build",
      key: "build",
      before: { status: "not run" },
      after: { status: "not run" },
    },
  ];

  it("omits a top-level recorded build command when the table marks build not run", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReliquaryView, {
        runId: "run-build-top",
        owner: "octocat",
        repo: "legacy",
        baseSha: "abc1234def",
        certificate: { build: { command: "npm run build" } },
        beforeAfterRows: buildNotRunRows,
      })
    );
    assert.ok(html.includes('data-testid="open-in-kiro-handoff"'));
    assert.ok(!html.includes("npm run build"));
  });

  it("omits a rows-recorded build command when the table marks build not run", () => {
    const html = renderToStaticMarkup(
      React.createElement(ReliquaryView, {
        runId: "run-build-rows",
        owner: "octocat",
        repo: "legacy",
        baseSha: "abc1234def",
        certificate: { rows: [{ step: "build", command: "npm run build" }] },
        beforeAfterRows: buildNotRunRows,
      })
    );
    assert.ok(html.includes('data-testid="open-in-kiro-handoff"'));
    assert.ok(!html.includes("npm run build"));
  });
});
describe("Open in Kiro handoff: REPL and shell verification steps are separated", () => {
  const RESUME_TITLE = "Resume development locally with the Kiro CLI";
  const VERIFY_TITLE = "Verify locally in your shell";

  it("keeps the REPL commands separate from the shell verification step", () => {
    const plan = buildKiroHandoff({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-split",
      verificationCommands: ["pytest -q", "npm run lint"],
    });

    const resume = plan.steps.find((s) => s.title === RESUME_TITLE);
    const verify = plan.steps.find((s) => s.title === VERIFY_TITLE);
    assert.ok(resume, "resume step must exist");
    assert.ok(verify, "verify step must exist when verification commands are recorded");

    // The REPL step only launches the CLI and runs the spec.
    assert.deepEqual(resume!.commands, ["kiro-cli", "/spec run resurrection"]);
    // Shell verification commands are isolated in their own step.
    assert.deepEqual(verify!.commands, ["pytest -q", "npm run lint"]);
    // The REPL step never contains the shell verification commands.
    assert.ok(!resume!.commands.some((c) => verify!.commands.includes(c)));
  });

  it("omits the shell verification step when no verification commands are recorded", () => {
    const plan = buildKiroHandoff({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-no-verify",
    });
    assert.ok(!plan.steps.some((s) => s.title === VERIFY_TITLE));
    const resume = plan.steps.find((s) => s.title === RESUME_TITLE);
    assert.deepEqual(resume!.commands, ["kiro-cli", "/spec run resurrection"]);
  });

  it("states the downloaded spec/ directory goes inside the clone directory", () => {
    const plan = buildKiroHandoff({
      owner: "octocat",
      repo: "legacy",
      baseSha: "abc1234def",
      runId: "run-spec-dir",
    });
    const copyStep = plan.steps.find(
      (s) => s.title === "Copy the spec bundle into Kiro's spec folder"
    );
    assert.ok(copyStep, "spec copy step must exist");
    assert.ok(copyStep!.detail.includes(plan.cloneDir));
    assert.match(copyStep!.detail, /inside /);
    assert.ok(copyStep!.commands.includes(`cp -R spec/. ${plan.specCopyTarget}`));
  });
});