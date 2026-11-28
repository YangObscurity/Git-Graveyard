import * as fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type APIRequestContext, type Page } from "@playwright/test";

const bundledBrowserExists = fs.existsSync(chromium.executablePath());
const fallbackExecutablePath = !bundledBrowserExists
  ? ["/usr/bin/chromium", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p))
  : undefined;

if (fallbackExecutablePath) {
  test.use({
    launchOptions: {
      executablePath: fallbackExecutablePath,
    },
  });
}

async function stepSimRun(
  request: APIRequestContext,
  runId: string,
  step: string
) {
  const res = await request.post("/api/debug/sim", {
    headers: { "x-admin-token": "e2e-admin-token" },
    data: { action: "step_run", runId, step },
  });
  expect(res.ok()).toBe(true);
  return res.json();
}

async function expectNoSeriousOrCriticalA11yViolations(
  page: Page,
  contextLabel: string
) {
  const results = await new AxeBuilder({ page }).analyze();
  const severe = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical"
  );
  expect(
    severe,
    `Axe serious/critical violations on ${contextLabel}:\n${JSON.stringify(
      severe.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => n.target),
      })),
      null,
      2
    )}`
  ).toEqual([]);
}

test.describe("Accessibility Audit & Controls (Axe-Core WCAG AA + Keyboard + Reduced Motion)", () => {
  test("audits live Tombstone -> Pact -> Legion (including TaskGraph roving tabindex) -> Reliquary flow", async ({
    page,
  }) => {
    const inviteCode = `e2e-a11y-${Date.now()}`;
    const inviteRes = await page.request.post("/api/debug/sim", {
      headers: { "x-admin-token": "e2e-admin-token" },
      data: {
        action: "create_invite",
        code: inviteCode,
        allowedRunCount: 5,
        caps: { maxMinutes: 30, maxParallel: 2, maxToolCalls: 80 },
      },
    });
    expect(inviteRes.ok()).toBe(true);

    await page.route("**/api/run-autopsy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          owner: "octocat",
          repo: "hello-world",
          fullName: "octocat/hello-world",
          sha: "deadbeef1234567890abcdef1234567890abcdef",
          defaultBranch: "main",
          status: "dead",
          deadReasons: ["deprecated_dependencies"],
          cause: "Legacy Node package uses deprecated dependencies.",
          lastWords: "Freeze legacy build",
          lifespanYears: 4,
          yearsDead: 3,
          stars: 128,
          forks: 19,
          languages: ["JavaScript"],
          asOf: "2026-11-17T00:00:00.000Z",
          chips: [
            {
              ruleId: "M1",
              file: "package.json",
              line: 12,
              target: "package.json:12",
              snippet: '"node": "0.10"',
            },
          ],
          signalChips: {
            M1: [
              {
                ruleId: "M1",
                file: "package.json",
                line: 12,
                target: "package.json:12",
                snippet: '"node": "0.10"',
              },
            ],
            M2: [],
            M3: [],
            M4: [],
            M5: [],
            M6: [],
          },
        }),
      });
    });

    // Submit run via Gate
    await page.goto("/");
    await page.getByTestId("repo-url-input").fill("https://github.com/octocat/hello-world");
    await page.getByTestId("invite-code-input").fill(inviteCode);
    await page.getByTestId("submit-start-run").click();

    await expect(page).toHaveURL(/\/tomb\/octocat\/hello-world\?run=run-/);
    const runId = new URL(page.url()).searchParams.get("run") ?? "";
    expect(runId).toMatch(/^run-/);

    // Tombstone
    await expect(page.getByTestId("tombstone-view")).toBeVisible();
    await stepSimRun(page.request, runId, "exhume");
    await expect(page.getByTestId("exhume-running-panel")).toBeVisible();
    await stepSimRun(page.request, runId, "certificate");
    await expect(page.getByTestId("death-certificate-view")).toBeVisible();
    await expectNoSeriousOrCriticalA11yViolations(page, "Tombstone");

    await stepSimRun(page.request, runId, "plan");
    await stepSimRun(page.request, runId, "pact");

    // Pact
    await page.getByTestId("ask-pact-button").click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/pact$`));
    await expect(page.getByTestId("pact-editor")).toBeVisible();
    await expectNoSeriousOrCriticalA11yViolations(page, "Pact");

    // Approve Pact -> Legion
    await page.getByTestId("pact-btn-approve").click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/legion$`));
    await expect(page.locator('[data-ui-element="legion-dashboard"]')).toBeVisible();

    await stepSimRun(page.request, runId, "legion");
    await stepSimRun(page.request, runId, "approval");
    await stepSimRun(page.request, runId, "ask");

    await expect(page.locator('[data-ui-element="legion-skeleton-card"]').first()).toBeVisible();
    await expect(page.locator('[data-ui-element="legion-approval-card"]')).toBeVisible();
    await expect(page.getByTestId("legion-open-asks")).toBeVisible();

    // Verify TaskGraph roving tabindex with ArrowRight / Home / End when TaskGraph is visible
    const taskGraph = page.getByTestId("task-graph");
    if (await taskGraph.isVisible().catch(() => false)) {
      const nodes = taskGraph.locator('[data-testid^="task-graph-node-"]');
      const nodeCount = await nodes.count();
      if (nodeCount >= 2) {
        await nodes.first().focus();
        await expect(nodes.first()).toBeFocused();
        await page.keyboard.press("ArrowRight");
        await expect(nodes.nth(1)).toBeFocused();
        await page.keyboard.press("End");
        await expect(nodes.nth(nodeCount - 1)).toBeFocused();
        await page.keyboard.press("Home");
        await expect(nodes.first()).toBeFocused();
      }
    }

    await expectNoSeriousOrCriticalA11yViolations(page, "Legion");

    // Complete run & audit live Reliquary
    await stepSimRun(page.request, runId, "done_resurrected");
    await stepSimRun(page.request, runId, "publish");
    await page.goto(`/runs/${runId}/relic`);
    await expect(page.getByTestId("outcome-text")).toHaveText("Resurrected");
    await expectNoSeriousOrCriticalA11yViolations(page, "Reliquary (live run)");
  });

  test("audits static & seeded screens (Gate, History, Replay, Reliquary, Built with Kiro, Admin) with zero serious/critical violations", async ({
    page,
  }) => {
    // 1. Gate (/)
    await page.goto("/");
    await expect(page.getByTestId("health-badge-text")).toHaveText("Live runs: open");
    await expectNoSeriousOrCriticalA11yViolations(page, "Gate (/)");

    // SkipLink becomes visible on keyboard focus and points to #main-content
    await page.keyboard.press("Tab");
    const skipLink = page.getByTestId("a11y-skip-link");
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toHaveAttribute("href", "#main-content");

    // 2. History (/history)
    await page.goto("/history");
    await expect(page.getByTestId("history-run-live-gulp-plumber-t40")).toBeVisible();
    await expectNoSeriousOrCriticalA11yViolations(page, "History (/history)");

    // 3. Replay (/replay redirects to /history, /replay/<runId> renders ReplayPlayer)
    await page.goto("/replay");
    await expect(page).toHaveURL(/\/history$/);

    await page.goto("/replay/live-gulp-plumber-t40");
    await expect(page.getByTestId("replay-banner")).toBeVisible();
    await expect(page.getByTestId("replay-event-1")).toBeVisible();
    await expectNoSeriousOrCriticalA11yViolations(
      page,
      "Replay (/replay/live-gulp-plumber-t40)"
    );

    // Verify Reduced Motion toggle affects html[data-ui-reduced-motion="true"] and ReplayPlayer
    const reducedMotionBtn = page.getByTestId("a11y-reduced-motion-toggle");
    await reducedMotionBtn.click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-ui-reduced-motion",
      "true"
    );
    await expect(page.getByTestId("replay-player")).toHaveAttribute(
      "data-reduced-motion",
      "true"
    );

    // Verify Shortcuts toggle disables global ReplayPlayer shortcuts cleanly
    await page.getByTestId("replay-reset").click();
    await expect(page.getByTestId("replay-event-1")).toHaveCount(0);

    await page.getByTestId("a11y-shortcuts-toggle").click();
    await expect(page.getByTestId("a11y-shortcuts-toggle")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await page.locator("#main-content").click();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("replay-event-1")).toHaveCount(0);

    // Re-enable shortcuts & verify ArrowRight steps forward
    await page.getByTestId("a11y-shortcuts-toggle").click();
    await page.locator("#main-content").click();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("replay-event-1")).toBeVisible();

    // Reset toggles cleanly
    await reducedMotionBtn.click();
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-ui-reduced-motion",
      "true"
    );

    // 4. Seeded Reliquary (/runs/live-gulp-plumber-t40/relic)
    await page.goto("/runs/live-gulp-plumber-t40/relic");
    await expect(page.getByTestId("reliquary-diff-viewer")).toBeVisible();
    const togglePlain = page.getByTestId("toggle-diff-view");
    if (await togglePlain.isVisible().catch(() => false)) {
      await togglePlain.click();
    }
    await expect(page.getByTestId("pre-diff-container")).toBeVisible();
    await expectNoSeriousOrCriticalA11yViolations(
      page,
      "Reliquary (/runs/live-gulp-plumber-t40/relic)"
    );

    // 5. Built with Kiro (/built-with-kiro)
    await page.goto("/built-with-kiro");
    await expect(page.locator("main")).toBeVisible();
    await expectNoSeriousOrCriticalA11yViolations(
      page,
      "Built with Kiro (/built-with-kiro)"
    );

    // 6. Admin (/admin sign-in and signed-in dashboard)
    await page.goto("/admin");
    await expect(page.locator("main")).toBeVisible();
    await expectNoSeriousOrCriticalA11yViolations(page, "Admin sign-in (/admin)");

    const adminInput = page.getByTestId("admin-token-input");
    if (await adminInput.isVisible().catch(() => false)) {
      await adminInput.fill("e2e-admin-token");
      await page.getByTestId("admin-signin-button").click();
      await expect(page.getByTestId("admin-dashboard")).toHaveAttribute(
        "data-ui-state",
        "authenticated"
      );
      await expectNoSeriousOrCriticalA11yViolations(
        page,
        "Admin dashboard (/admin)"
      );
    }
  });
});
