import { expect, test } from "@playwright/test";

test.describe("Gate, History, Replay, and Reliquary (T40 Recorded Run)", () => {
  test("validates Gate URL form, footer, History T40 listing, Replay seq order, and Reliquary artifacts", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // 1. Gate (/)
    await page.goto("/");

    const healthBadge = page.getByTestId("health-badge");
    await expect(healthBadge).toBeVisible();
    await expect(page.getByTestId("health-badge-text")).toHaveText("Live runs: open");

    const footer = page.getByTestId("gate-footer");
    await expect(footer).toContainText(
      "Skeleton sessions run on Kiro CLI. Git-Graveyard is an independent project."
    );

    // URL validation error for malformed URL
    await page.getByTestId("repo-url-input").fill("not-a-valid-github-url");
    await page.getByTestId("submit-diagnose-autopsy").click();
    const formError = page.getByTestId("form-error-message");
    await expect(formError).toBeVisible();
    await expect(formError).toContainText("Invalid repository URL");

    // 2. History (/history) — verify real T40 recorded run is seeded & listed
    await page.goto("/history");

    const t40Row = page.getByTestId("history-run-live-gulp-plumber-t40");
    await expect(t40Row).toBeVisible();
    await expect(t40Row.getByTestId("recorded-run-label")).toHaveText("Recorded run");
    await expect(t40Row.getByTestId("history-run-repo")).toHaveText("floatdrop/gulp-plumber");
    await expect(t40Row.getByTestId("history-run-outcome")).toContainText("Resurrected");

    // 3. Replay (/replay/live-gulp-plumber-t40)
    await page.getByTestId("history-replay-link-live-gulp-plumber-t40").click();
    await expect(page).toHaveURL(/\/replay\/live-gulp-plumber-t40$/);

    const replayBanner = page.getByTestId("replay-banner");
    await expect(replayBanner).toBeVisible();
    await expect(page.getByTestId("replay-badge")).toContainText("Replay");
    await expect(page.getByTestId("replay-run-id")).toHaveText("Run: live-gulp-plumber-t40");

    // Wait for recorded events (seq 1..66) to render
    await expect(page.getByTestId("replay-event-1")).toBeVisible();
    await expect(page.getByTestId("replay-event-66")).toBeVisible();

    const seqTexts = await page.locator('[data-testid^="replay-event-"] [data-testid="event-seq"]').allTextContents();
    const seqNumbers = seqTexts.map((t) => Number.parseInt(t.replace(/[^0-9]/g, ""), 10));
    expect(seqNumbers.length).toBe(66);
    for (let i = 0; i < seqNumbers.length; i++) {
      expect(seqNumbers[i]).toBe(i + 1);
    }

    // Strictly zero live run-action buttons on Replay screen
    const runActionButtons = page.getByRole("button", {
      name: /^(Pause run|Resume run|Stop run|Kill run)$/i,
    });
    expect(await runActionButtons.count()).toBe(0);

    // 4. Reliquary (/runs/live-gulp-plumber-t40/relic)
    await page.getByTestId("replay-reliquary-link").click();
    await expect(page).toHaveURL(/\/runs\/live-gulp-plumber-t40\/relic$/);

    await expect(page.getByTestId("reliquary-outcome-banner")).toBeVisible();
    await expect(page.getByTestId("outcome-text")).toHaveText("Resurrected");

    // Before/After verification table
    const table = page.getByTestId("before-after-table");
    await expect(table).toBeVisible();
    await expect(page.getByTestId("cell-install-before")).toContainText("passed");
    await expect(page.getByTestId("cell-install-after")).toContainText("passed");
    await expect(page.getByTestId("cell-tests_repo-before")).toContainText("failed");
    await expect(page.getByTestId("cell-tests_repo-after")).toContainText("passed");

    // Unified DiffViewer
    const diffViewer = page.getByTestId("reliquary-diff-viewer");
    await expect(diffViewer).toBeVisible();
    const togglePlain = page.getByTestId("toggle-diff-view");
    if (await togglePlain.isVisible().catch(() => false)) {
      await togglePlain.click();
    }
    await expect(page.getByTestId("pre-diff-container")).toBeVisible();

    // Task Ledger
    const ledger = page.getByTestId("section-task-ledger");
    await expect(ledger).toContainText("T1");
    await expect(ledger).toContainText("merged");
    await expect(ledger).toContainText("approve");

    // All 5 downloadable artifacts with non-placeholder SHA-256 checksums (!e3b0c442)
    const artifactSpecs = [
      { id: "patch", fileName: "all.patch" },
      { id: "spec", fileName: "spec.json" },
      { id: "report", fileName: "report.md" },
      { id: "events", fileName: "events.ndjson" },
      { id: "certificate", fileName: "death-certificate.json" },
    ];
    for (const art of artifactSpecs) {
      await expect(page.getByTestId(`artifact-card-${art.id}`)).toBeVisible();
      const shaText = (await page.getByTestId(`artifact-sha-${art.id}`).textContent()) ?? "";
      expect(shaText.trim()).toMatch(/^[a-f0-9]{64}$/i);
      expect(shaText.toLowerCase()).not.toContain("e3b0c442");

      const dlRes = await page.request.get(
        `/runs/live-gulp-plumber-t40/relic/download?artifact=${art.id}`
      );
      expect(dlRes.status()).toBe(200);
      expect(dlRes.headers()["content-disposition"]).toContain(art.fileName);
      const bytes = await dlRes.body();
      expect(bytes.length).toBeGreaterThan(0);
    }

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
