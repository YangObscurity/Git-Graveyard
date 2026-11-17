import { expect, test, type APIRequestContext } from "@playwright/test";

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

test.describe("Full Resurrection User Journey (Gate -> Tomb -> Pact -> Legion -> Reliquary -> History)", () => {
  test("drives full resurrection flow with invite unlock, SSE updates, Pact locks, approvals, asks, and Reliquary", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    const inviteCode = `e2e-invite-${Date.now()}`;
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

    // Keep Tombstone autopsy deterministic offline without hitting external GitHub API rate limits
    await page.route("**/api/run-autopsy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          owner: "octocat",
          repo: "hello-legacy",
          fullName: "octocat/hello-legacy",
          sha: "deadbeef1234567890abcdef1234567890abcdef",
          defaultBranch: "main",
          status: "dead",
          deadReasons: ["deprecated_dependencies", "archived_or_stale"],
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

    // 1. Submit run via Gate UI
    await page.goto("/");
    await expect(page.getByTestId("health-badge-text")).toHaveText("Live runs: open");

    await page.getByTestId("repo-url-input").fill("https://github.com/octocat/hello-legacy");
    await page.getByTestId("invite-code-input").fill(inviteCode);
    await page.getByTestId("submit-start-run").click();

    await expect(page).toHaveURL(/\/tomb\/octocat\/hello-legacy\?run=run-/);
    const runId = new URL(page.url()).searchParams.get("run") ?? "";
    expect(runId).toMatch(/^run-/);

    // 2. Tombstone + Exhume SSE flow
    await expect(page.getByTestId("tombstone-view")).toBeVisible();
    await expect(page.getByTestId("repo-full-name")).toHaveText("octocat/hello-legacy");
    await expect(page.getByTestId("waiting-room-strip")).toBeVisible();

    await stepSimRun(page.request, runId, "exhume");
    await expect(page.getByTestId("exhume-running-panel")).toBeVisible();

    await stepSimRun(page.request, runId, "certificate");
    await expect(page.getByTestId("death-certificate-view")).toBeVisible();
    const askPactBtn = page.getByTestId("ask-pact-button");
    await expect(askPactBtn).toBeEnabled();

    await stepSimRun(page.request, runId, "plan");
    await stepSimRun(page.request, runId, "pact");

    // 3. Pact review (/runs/<id>/pact)
    await askPactBtn.click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/pact$`));
    await expect(page.getByTestId("pact-editor")).toBeVisible();

    // Non-removable verification locks must be enforced & visible
    await expect(page.getByTestId("locked-req-warden_final_check")).toBeVisible();
    await expect(page.getByTestId("locked-req-scribe_report")).toBeVisible();
    await expect(page.getByTestId("locked-req-grimoire_gate")).toBeVisible();
    await expect(page.getByTestId("task-checkbox-T2")).toBeDisabled();
    await expect(page.getByTestId("task-locked-badge-T2")).toContainText("[Locked]");

    // Approve Pact in UI -> navigates to Legion
    await page.getByTestId("pact-btn-approve").click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/legion$`));
    await expect(page.locator('[data-ui-element="legion-dashboard"]')).toBeVisible();

    // 4. Legion SSE updates: skeleton card, approval card, ask card
    await stepSimRun(page.request, runId, "legion");
    // Use specific skeleton id to avoid strict mode violation when multiple skeleton cards exist
    await expect(
      page.locator('[data-ui-element="legion-skeleton-card"][data-skeleton-id="skel-bonesetter-sim-1"]')
    ).toBeVisible();
    // Verify at least one skeleton card is visible in total
    expect(
      await page.locator('[data-ui-element="legion-skeleton-card"]').count()
    ).toBeGreaterThanOrEqual(1);
    await stepSimRun(page.request, runId, "approval");
    const approvalCard = page.locator('[data-ui-element="legion-approval-card"]');
    await expect(approvalCard).toBeVisible();
    await expect(approvalCard).toContainText("npm install --legacy-peer-deps");

    await stepSimRun(page.request, runId, "ask");
    const askSection = page.getByTestId("legion-open-asks");
    await expect(askSection).toBeVisible();
    await expect(askSection).toContainText(
      "Keep legacy Node compatibility shim or drop deprecated option?"
    );

    // Resolve approval & ask via UI
    await approvalCard.getByRole("button", { name: "Approve once" }).click();
    await expect(approvalCard).toHaveCount(0);

    await askSection.getByRole("button", { name: "Keep shim" }).click();
    await expect(askSection).toHaveCount(0);

    // 5. Verify 401/403 inline invite-code unlock + Pause/Resume on LegionRunControls
    await page.evaluate(() => window.sessionStorage.clear());

    const controls = page.locator('[data-ui-element="legion-controls"]');
    await controls.getByRole("button", { name: "Pause run" }).click();
    const unlockForm = page.getByTestId("legion-unlock-form");
    await expect(unlockForm).toBeVisible();

    await page.getByTestId("legion-unlock-code-input").fill(inviteCode);
    await page.getByTestId("legion-unlock-submit").click();
    await expect(unlockForm).toHaveCount(0);

    await controls.getByRole("button", { name: "Pause run" }).click();
    await expect(controls).toHaveAttribute("data-ui-state", "paused");

    await controls.getByRole("button", { name: "Resume" }).click();
    await expect(controls).toHaveAttribute("data-ui-state", "running");

    // 6. Complete run & publish -> verify Reliquary and History
    await stepSimRun(page.request, runId, "done_resurrected");
    await stepSimRun(page.request, runId, "publish");

    const doneBanner = page.getByTestId("legion-done-banner");
    await expect(doneBanner).toBeVisible();
    await doneBanner.getByRole("link", { name: "Open the Reliquary" }).click();

    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/relic$`));
    await expect(page.getByTestId("outcome-text")).toHaveText("Resurrected");
    await expect(page.getByTestId("before-after-table")).toBeVisible();
    await expect(page.getByTestId("reliquary-diff-viewer")).toBeVisible();
    await expect(page.getByTestId("section-task-ledger")).toContainText("T1");

    for (const id of ["patch", "spec", "report", "events", "certificate"]) {
      const sha = (await page.getByTestId(`artifact-sha-${id}`).textContent()) ?? "";
      expect(sha.trim()).toMatch(/^[a-f0-9]{64}$/i);
      expect(sha.toLowerCase()).not.toContain("e3b0c442");
    }

    await page.goto("/history");
    await expect(page.getByTestId(`history-run-${runId}`)).toBeVisible();
    await expect(page.getByTestId("history-run-live-gulp-plumber-t40")).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
