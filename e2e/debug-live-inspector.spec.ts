import { expect, test } from "@playwright/test";

test.describe("UI Debug Gallery, Live Runtime Inspector, and Live HUD", () => {
  test("verifies synthetic preset matrix, live backend inspector parity/artifacts, API probes, and HUD", async ({
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

    // 1. /debug/ui?uiDebug=1 Synthetic Fixture Matrix
    await page.goto("/debug/ui?uiDebug=1");
    const gallery = page.getByTestId("ui-debug-gallery");
    await expect(gallery).toBeVisible();

    for (const preset of [
      "loading",
      "empty",
      "active",
      "blocked",
      "failed",
      "resurrected",
    ]) {
      await page.getByTestId(`ui-debug-preset-${preset}`).click();
      await expect(gallery).toHaveAttribute("data-ui-state", preset);
    }

    // Cycle toggle in Pact section
    await page.getByTestId("ui-debug-toggle-cycle").click();
    await expect(page.getByTestId("pact-cycle-error")).toBeVisible();
    await page.getByTestId("ui-debug-toggle-cycle").click();
    await expect(page.getByTestId("pact-cycle-error")).toHaveCount(0);

    // 2. Switch to Live Runtime Inspector tab
    await page.getByTestId("ui-debug-mode-live").click();
    const liveInspector = page.getByTestId("ui-debug-live-inspector");
    await expect(liveInspector).toBeVisible();
    await expect(liveInspector).toHaveAttribute("data-ui-state", "ready");

    // Verify real live backend telemetry cards render
    await expect(liveInspector).toContainText("RunStore");
    await expect(liveInspector).toContainText("EventStore");
    await expect(liveInspector).toContainText("Phase 0 Probes");
    await expect(liveInspector).toContainText("Toolchain Probes");

    // Select T40 recorded run in Recent Runs
    const t40Selector = page.getByTestId("live-inspector-run-live-gulp-plumber-t40");
    await expect(t40Selector).toBeVisible();
    await t40Selector.click();

    const runDetail = page.getByTestId("live-inspector-run-detail");
    await expect(runDetail).toBeVisible();
    await expect(runDetail).toContainText("parity ok");
    await expect(runDetail).toContainText("1..66");
    await expect(runDetail).toContainText("Artifact SHA-256 Status (5)");
    await expect(runDetail).toContainText("all.patch");
    await expect(runDetail).toContainText("death-certificate.json");

    // Probe API endpoints
    const healthProbeBtn = page.getByTestId("live-probe-btn-health");
    await healthProbeBtn.click();
    await expect(healthProbeBtn).toContainText("200");

    const statusProbeBtn = page.getByTestId("live-probe-btn-debug_status");
    await statusProbeBtn.click();
    await expect(statusProbeBtn).toContainText("200");

    // 3. Visit /?uiDebug=1 and inspect floating UiDebugLiveHud + window.__GIT_GRAVEYARD_UI_DEBUG__
    await page.goto("/?uiDebug=1");
    const hud = page.getByTestId("ui-debug-live-hud");
    await expect(hud).toBeVisible();
    await page.getByTestId("ui-debug-hud-toggle").click();
    const drawer = page.getByTestId("ui-debug-hud-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("/?uiDebug=1");
    await expect(drawer).toContainText("RunStore: file");

    const inspection = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          __GIT_GRAVEYARD_UI_DEBUG__?: {
            inspectCurrentPage: (opts?: { probeToolchains?: boolean }) => Promise<{
              client: { pathname: string; uiDebugActive: boolean };
              domElements: Array<{ element: string }>;
              themeTokens: Record<string, string>;
              backend: { ok: boolean; status?: { ok: boolean } | null };
            }>;
          };
        }
      ).__GIT_GRAVEYARD_UI_DEBUG__;
      if (!api) return null;
      return await api.inspectCurrentPage({ probeToolchains: false });
    });

    expect(inspection).not.toBeNull();
    expect(inspection!.client.pathname).toBe("/");
    expect(inspection!.client.uiDebugActive).toBe(true);
    expect(inspection!.domElements.length).toBeGreaterThan(0);
    expect(Object.keys(inspection!.themeTokens).length).toBeGreaterThan(0);
    expect(inspection!.backend.ok).toBe(true);
    expect(inspection!.backend.status?.ok).toBe(true);

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
