import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { hrefForRun, routes, stageForPhase } from "@/lib/ui/run-routes";
import { buildRunView } from "@/lib/ui/run-model";
import { certificateFromRun } from "@/lib/ui/certificate";
import { parseEventsData } from "@/components/ReliquaryView";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every page and route handler under app/, as a matcher for concrete paths. */
function appRoutes(): { pattern: string; test: RegExp }[] {
  const appDir = path.join(ROOT, "app");
  return walk(appDir)
    .filter((f) => /[\\/](page\.tsx|route\.ts)$/.test(f))
    .map((f) => {
      const rel = path
        .relative(appDir, path.dirname(f))
        .split(path.sep)
        .filter(Boolean);
      const pattern = "/" + rel.join("/");
      const source = rel
        .map((seg) => (/^\[.+\]$/.test(seg) ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/");
      return { pattern, test: new RegExp(`^/${source}/?$`) };
    });
}

const ROUTES = appRoutes();

function resolves(href: string): boolean {
  const pathname = href.split(/[?#]/)[0];
  return ROUTES.some((r) => r.test.test(pathname));
}

/** Internal link targets written in component and page sources. */
function linkTargets(): { file: string; href: string }[] {
  const files = [
    ...walk(path.join(ROOT, "components")),
    ...walk(path.join(ROOT, "app")),
  ].filter((f) => f.endsWith(".tsx"));
  const found: { file: string; href: string }[] = [];
  const patterns = [
    /href=\{?["'`](\/[^"'`]*)["'`]\}?/g,
    /(?:router\.(?:push|replace)|redirect)\(\s*["'`](\/[^"'`]*)["'`]/g,
    /(?:const|let)\s+target\w*\s*=\s*[^;]*?["'`](\/[^"'`]*)["'`]/g,
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        // Template placeholders stand for one path segment (or a query value).
        const href = match[1].replace(/\$\{[^}]*\}/g, "x");
        found.push({ file: path.relative(ROOT, file), href });
      }
    }
  }
  return found;
}

describe("journey contract: every link lands on a real route", () => {
  it("finds the app routes", () => {
    const patterns = ROUTES.map((r) => r.pattern);
    for (const expected of [
      "/",
      "/history",
      "/tomb/[owner]/[repo]",
      "/runs/[runId]",
      "/runs/[runId]/pact",
      "/runs/[runId]/legion",
      "/runs/[runId]/relic",
      "/runs/[runId]/relic/download",
      "/replay",
      "/replay/[runId]",
      "/api/runs/[runId]/events",
    ]) {
      assert.ok(patterns.includes(expected), `missing route ${expected}`);
    }
  });

  it("route helpers produce paths that exist", () => {
    const hrefs = [
      routes.gate(),
      routes.history(),
      routes.tomb("owner", "repo"),
      routes.run("run-1"),
      routes.pact("run-1"),
      routes.legion("run-1"),
      routes.relic("run-1"),
      routes.replay("run-1"),
      routes.eventLog("run-1"),
    ];
    for (const href of hrefs) {
      assert.ok(resolves(href), `route helper produced a dead path: ${href}`);
    }
  });

  it("every phase of a run maps to a screen that exists", () => {
    for (const phase of [
      "queued",
      "exhume",
      "plan",
      "pact_review",
      "legion",
      "final_check",
      "report",
      "done",
    ]) {
      const href = hrefForRun("run-1", phase);
      assert.ok(resolves(href), `${phase} -> ${href} is not a route`);
      assert.ok(["pact", "legion", "relic"].includes(stageForPhase(phase)));
    }
  });

  it("no component or page links to a path without a route", () => {
    const targets = linkTargets();
    assert.ok(targets.length > 10, "link scan found too few targets to be trusted");
    const dead = targets.filter((t) => !resolves(t.href));
    assert.deepEqual(
      dead,
      [],
      `dead links: ${dead.map((d) => `${d.file} -> ${d.href}`).join(", ")}`
    );
  });
});

describe("journey contract: no screen states a value the run did not record", () => {
  const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

  it("Tombstone shows no computed score", () => {
    const source = read("components/TombstoneView.tsx");
    assert.ok(!/vitality/i.test(source));
    assert.ok(!/\/ 100/.test(source));
  });

  it("Exhume builds the certificate from recorded commands only", () => {
    const source = read("components/ExhumeView.tsx");
    assert.ok(!source.includes('status: "passed"'));
    assert.ok(!source.includes("runtime version checks"));
    assert.ok(!source.includes("30 minutes"));

    const view = buildRunView([
      { seq: 1, ts: 10, kind: "run.phase", data: { phase: "exhume" } },
      {
        seq: 2,
        ts: 20,
        kind: "command.result",
        data: { commandLine: "npm ci", step: "install", exitCode: 1, status: "failed" },
      },
      {
        seq: 3,
        ts: 30,
        kind: "exhume.certificate",
        data: { baseSha: "abc1234", healthy: false, failureClasses: ["install_failed"], sha256: "d".repeat(64) },
      },
    ]);
    const cert = certificateFromRun(view, "run-1");
    assert.ok(cert);
    assert.equal(cert.install.status, "failed");
    assert.equal(cert.install.command, "npm ci");
    // Steps the log never reported are "not run", never "passed".
    assert.equal(cert.build.status, "not run");
    assert.equal(cert.test.status, "not run");
    assert.equal(cert.rows.length, 1);
    assert.equal(cert.healthy, false);
    assert.equal(certificateFromRun(buildRunView([]), "run-1"), null);
  });

  it("the Reliquary outcome cannot be set from the URL", () => {
    const page = read("app/runs/[runId]/relic/page.tsx");
    assert.ok(!page.includes("outcome="));
    assert.ok(!page.includes("searchParams?.outcome"));
    const view = read("components/ReliquaryView.tsx");
    assert.ok(!view.includes('"Install passed", "Build passed"'));
  });

  it("Legion and its header carry no default budget ceilings", () => {
    const dashboard = read("components/LegionDashboard.tsx");
    assert.ok(!dashboard.includes("useState<number>(60)"));
    assert.ok(!dashboard.includes("useState<number>(45)"));
    const header = read("components/LegionRunHeader.tsx");
    assert.ok(!header.includes("toolCallsCap = 60"));
    assert.ok(!header.includes("wallClockCapMinutes = 45"));
  });

  it("Reliquary parses task.merged, exhume.certificate, and final_check.result from events", () => {
    const parsed = parseEventsData([
      {
        runId: "r-1",
        seq: 1,
        ts: 100,
        kind: "exhume.certificate",
        actor: "exhumer",
        data: { baseSha: "abc1234def", refs: [] },
      },
      {
        runId: "r-1",
        seq: 2,
        ts: 200,
        kind: "task.merged",
        actor: "dispatcher",
        taskId: "T1",
        attempt: 2,
        data: { taskId: "T1", attempt: 2, refs: [] },
      },
      {
        runId: "r-1",
        seq: 3,
        ts: 300,
        kind: "final_check.result",
        actor: "warden",
        data: { passed: false, buildPassed: true, testsPassed: false, refs: [] },
      },
    ]);
    assert.equal(parsed.baseSha, "abc1234def");
    assert.equal(parsed.buildPassed, true);
    assert.equal(parsed.testsPassed, false);
    assert.equal(parsed.tasks?.T1.state, "merged");
    assert.equal(parsed.tasks?.T1.attempts, 2);
  });
});
