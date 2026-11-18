import test, { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DebugUiPage from "@/app/debug/ui/page";
import { UiDebugGallery, type UiDebugGalleryProps } from "@/components/debug/UiDebugGallery";
import { LiveStateInspector } from "@/components/debug/LiveStateInspector";
import { UiDebugLiveHud } from "@/components/debug/UiDebugLiveHud";
import { UiDebugBootstrap } from "@/components/ui/UiDebugBootstrap";
import {
  clearLiveRunStreamSnapshot,
  createUiDebugApi,
  getLiveClientState,
  reportLiveRunStreamSnapshot,
  subscribeUiDebugState,
} from "@/lib/ui-debug";
import { useRunStream } from "@/lib/ui/use-run-stream";
import { DEBUG_PRESET_MODES, getUiFixturesForPreset } from "@/lib/debug/ui-fixtures";
import { CryptNav, type CryptNavProps } from "@/components/ui/CryptNav";
import { StatusPill } from "@/components/ui/StatusPill";
import { HealthBadge, type HealthBadgeProps } from "@/components/HealthBadge";
import { SignalChip } from "@/components/SignalChip";
import { CommandRow } from "@/components/CommandRow";
import { ReceiptViewer } from "@/components/ReceiptViewer";
import { HistoryList } from "@/components/HistoryList";
import { ReplayPlayer } from "@/components/ReplayPlayer";
import { LegionAskCard } from "@/components/LegionAskCard";
import { RunEntry } from "@/components/RunEntry";

describe("Slice 6: UI Debug & Showcase Lab Contract", () => {
  const originalFetch = globalThis.fetch;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  });

  describe("(a) UiDebugGallery SSR rendering across all 6 presets with zero network calls", () => {
    it("renders all 6 preset modes via renderToStaticMarkup without throwing or calling fetch", () => {
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        throw new Error("Network call should not happen in /debug/ui SSR");
      }) as typeof fetch;

      for (const mode of DEBUG_PRESET_MODES) {
        const html = renderToStaticMarkup(
          React.createElement(
            UiDebugGallery as React.ComponentType<UiDebugGalleryProps>,
            {
              initialPreset: mode,
              initialViewport: "full",
            }
          )
        );

        assert.ok(
          html.includes('data-testid="ui-debug-gallery"'),
          `Preset ${mode} must render ui-debug-gallery`
        );
        assert.ok(
          html.includes('data-ui-element="ui-debug-gallery"'),
          `Preset ${mode} must emit data-ui-element="ui-debug-gallery"`
        );
        assert.ok(
          html.includes(`data-ui-state="${mode}"`),
          `Preset ${mode} must emit data-ui-state="${mode}"`
        );
        assert.ok(
          html.includes(`data-testid="ui-debug-preset-${mode}"`),
          `Preset ${mode} button must exist`
        );
      }

      assert.equal(fetchCalled, false, "SSR render must never call fetch");
    });

    it("renders DebugUiPage async server component with ?uiDebug=1 and enforces production lock", async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";

      const lockedEl = await DebugUiPage({
        searchParams: Promise.resolve({}),
      });
      const lockedHtml = renderToStaticMarkup(lockedEl);
      assert.ok(
        lockedHtml.includes("UI Lab locked"),
        "Production access without ?uiDebug=1 must render lock notice"
      );
      assert.ok(!lockedHtml.includes('data-testid="ui-debug-gallery"'));

      const unlockedEl = await DebugUiPage({
        searchParams: Promise.resolve({
          uiDebug: "1",
          state: "resurrected",
          viewport: "tablet",
        }),
      });
      const unlockedHtml = renderToStaticMarkup(unlockedEl);
      assert.ok(
        unlockedHtml.includes('data-testid="ui-debug-gallery"'),
        "Production access with ?uiDebug=1 must render UiDebugGallery"
      );
      assert.ok(unlockedHtml.includes('data-ui-state="resurrected"'));
      assert.ok(unlockedHtml.includes('data-ui-variant="tablet"'));
    });
  });

  describe("(b) data-ui-element and data-ui-state contract across core primitives & Slice 6 views", () => {
    it("emits data-ui-element and data-ui-state on Slice 1 primitives", () => {
      const navHtml = renderToStaticMarkup(
        React.createElement(CryptNav as React.ComponentType<CryptNavProps>, {
          currentPath: "/debug/ui",
        })
      );
      assert.ok(navHtml.includes('data-ui-element="crypt-nav"'));
      assert.ok(navHtml.includes('data-ui-state="debug"'));

      const pillHtml = renderToStaticMarkup(
        React.createElement(StatusPill, {
          tone: "emerald",
          label: "Resurrected",
          uiState: "resurrected",
        })
      );
      assert.ok(pillHtml.includes('data-ui-element="status-pill"'));
      assert.ok(pillHtml.includes('data-ui-state="resurrected"'));
      assert.ok(pillHtml.includes('data-ui-variant="emerald"'));

      const healthHtml = renderToStaticMarkup(
        React.createElement(
          HealthBadge as React.ComponentType<HealthBadgeProps>,
          { status: "open", loading: false }
        )
      );
      assert.ok(healthHtml.includes('data-ui-element="health-badge"'));
      assert.ok(healthHtml.includes('data-ui-state="open"'));

      const chipHtml = renderToStaticMarkup(
        React.createElement(SignalChip, {
          chip: {
            ruleId: "M1",
            file: "package.json",
            line: 42,
            confidence: "high",
          },
        })
      );
      assert.ok(chipHtml.includes('data-ui-element="signal-chip"'));
      assert.ok(chipHtml.includes('data-ui-state="critical"'));

      const cmdHtml = renderToStaticMarkup(
        React.createElement(CommandRow, {
          row: {
            step: "test",
            command: "npm test",
            status: "passed",
            exitCode: 0,
            durationMs: 420,
          },
        })
      );
      assert.ok(cmdHtml.includes('data-ui-element="command-row"'));
      assert.ok(cmdHtml.includes('data-ui-state="passed"'));

      const receiptHtml = renderToStaticMarkup(
        React.createElement(ReceiptViewer, {
          chip: {
            ruleId: "M2",
            file: "src/parser.ts",
            line: 88,
            snippet: "return new Buffer(raw);",
          },
        })
      );
      assert.ok(receiptHtml.includes('data-ui-element="receipt-viewer"'));
      assert.ok(receiptHtml.includes('data-ui-state="ready"'));
    });

    it("emits data-ui-element and data-ui-state on HistoryList and ReplayPlayer", () => {
      const historyEmptyHtml = renderToStaticMarkup(
        React.createElement(HistoryList, { initialRuns: [] })
      );
      assert.ok(historyEmptyHtml.includes('data-ui-element="history-list"'));
      assert.ok(historyEmptyHtml.includes('data-ui-state="empty"'));

      const historyPopulatedHtml = renderToStaticMarkup(
        React.createElement(HistoryList, {
          initialRuns: [
            {
              runId: "run-1",
              repository: "owner/repo",
              isPublished: true,
              outcome: "resurrected",
            },
          ],
        })
      );
      assert.ok(historyPopulatedHtml.includes('data-ui-element="history-list"'));
      assert.ok(historyPopulatedHtml.includes('data-ui-state="populated"'));

      const replayHtml = renderToStaticMarkup(
        React.createElement(ReplayPlayer, {
          runId: "run-replay-1",
          initialEvents: [
            {
              runId: "run-replay-1",
              seq: 1,
              ts: 1731672000000,
              kind: "run.done",
              actor: "system",
              data: { refs: [] },
            },
          ],
        })
      );
      assert.ok(replayHtml.includes('data-ui-element="replay-player"'));
      assert.ok(replayHtml.includes('data-ui-state="ended"'));
      assert.ok(replayHtml.includes('data-ui-variant="1x"'));

      const askHtml = renderToStaticMarkup(
        React.createElement(LegionAskCard, {
          ask: {
            askId: "ask-1",
            question: "Patch or drop gulp task?",
            options: ["Patch", "Drop"],
          },
        })
      );
      assert.ok(askHtml.includes('data-ui-element="legion-ask-card"'));
      assert.ok(askHtml.includes('data-ui-state="open"'));

      const entryHtml = renderToStaticMarkup(
        React.createElement(RunEntry, { runId: "run-entry-1" })
      );
      assert.ok(entryHtml.includes('data-ui-element="run-entry"'));
      assert.ok(entryHtml.includes('data-ui-state="loading"'));
    });
  });

  describe("(c) Zero e3b0c442 placeholder leakage in /debug/ui", () => {
    it("never emits e3b0c442 in fixtures or rendered gallery across all presets", () => {
      for (const mode of DEBUG_PRESET_MODES) {
        const bundle = getUiFixturesForPreset(mode);
        const serialized = JSON.stringify(bundle);
        assert.ok(
          !serialized.includes("e3b0c442"),
          `Fixture bundle for ${mode} must not contain e3b0c442`
        );

        const html = renderToStaticMarkup(
          React.createElement(
            UiDebugGallery as React.ComponentType<UiDebugGalleryProps>,
            { initialPreset: mode }
          )
        );
        assert.ok(
          !html.includes("e3b0c442"),
          `Rendered UiDebugGallery for ${mode} must not contain e3b0c442`
        );
      }
    });
  });

  describe("(d) Live runtime state store, inspector, and HUD SSR contract", () => {
    it("manages LiveRunStreamSnapshot updates and subscriptions safely in Node/SSR", () => {
      clearLiveRunStreamSnapshot("run-stream-test-1");
      const initial = getLiveClientState();
      assert.equal(initial.isBrowser, false);
      assert.equal(initial.pathname, "/");
      assert.equal(initial.search, "");
      assert.equal(initial.uiDebugActive, false);

      const notifications: number[] = [];
      const unsubscribe = subscribeUiDebugState((state) => {
        notifications.push(state.activeRuns.length);
      });

      try {
        reportLiveRunStreamSnapshot("run-stream-test-1", {
          runId: "run-stream-test-1",
          loading: false,
          reconnecting: false,
          loadError: null,
          lastSeq: 12,
          phase: "legion",
          outcome: null,
          pactStatus: "approved",
          pactVersion: 2,
          skeletonCount: 3,
          pendingApprovalsCount: 1,
          openAsksCount: 0,
          taskCount: 4,
          updatedAt: 1731672000000,
        });

        const active = getLiveClientState();
        const found = active.activeRuns.find((r) => r.runId === "run-stream-test-1");
        assert.ok(found, "reported snapshot must appear in activeRuns");
        assert.equal(found.phase, "legion");
        assert.equal(found.lastSeq, 12);
        assert.equal(found.pactStatus, "approved");
        assert.equal(found.skeletonCount, 3);
        assert.equal(found.pendingApprovalsCount, 1);
        assert.ok(notifications.length >= 1);

        clearLiveRunStreamSnapshot("run-stream-test-1");
        const cleared = getLiveClientState();
        assert.equal(
          cleared.activeRuns.some((r) => r.runId === "run-stream-test-1"),
          false
        );

        const countBeforeUnsub = notifications.length;
        unsubscribe();
        reportLiveRunStreamSnapshot("run-stream-test-1", {
          loading: true,
          reconnecting: false,
          loadError: null,
          lastSeq: 1,
          phase: "queued",
          outcome: null,
          pactStatus: "none",
          pactVersion: null,
          skeletonCount: 0,
          pendingApprovalsCount: 0,
          openAsksCount: 0,
          taskCount: 0,
        });
        assert.equal(notifications.length, countBeforeUnsub);
      } finally {
        unsubscribe();
        clearLiveRunStreamSnapshot("run-stream-test-1");
      }
    });

    it("exposes backward-compatible and live diagnostic methods on createUiDebugApi()", async () => {
      const api = createUiDebugApi();
      assert.equal(api.version, "1.0.0");
      assert.deepEqual(api.listElements(), []);
      assert.deepEqual(api.getElementsBySlug("crypt-nav"), []);
      assert.deepEqual(api.getThemeTokens(), {});
      assert.equal(api.getLiveClientState().isBrowser, false);

      const requestedUrls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.startsWith("/api/debug/status")) {
          return new Response(
            JSON.stringify({ ok: false, code: "DEBUG_LOCKED", error: "Locked" }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ ok: true, runId: "run-xyz" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const result = await api.fetchBackendDiagnostics({
        runId: "run-xyz",
        probeToolchains: true,
      });
      assert.equal(result.ok, false);
      assert.equal(result.locked, true);
      assert.equal(result.statusCode, 403);
      assert.ok(requestedUrls.some((u) => u.includes("/api/debug/status?uiDebug=1&probeToolchains=1")));
      assert.ok(requestedUrls.some((u) => u.includes("/api/debug/runs/run-xyz?uiDebug=1")));
    });

    it("renders UiDebugGallery initialMode='live' and DebugUiPage ?mode=live with zero fetch calls and mode switchers", async () => {
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        throw new Error("Network call should not happen during SSR");
      }) as typeof fetch;

      const fixturesHtml = renderToStaticMarkup(
        React.createElement(
          UiDebugGallery as React.ComponentType<UiDebugGalleryProps>,
          { initialPreset: "active", initialMode: "fixtures" }
        )
      );
      assert.ok(fixturesHtml.includes('data-testid="ui-debug-mode-fixtures"'));
      assert.ok(fixturesHtml.includes('data-testid="ui-debug-mode-live"'));
      assert.ok(!fixturesHtml.includes('data-testid="ui-debug-live-inspector"'));

      const liveGalleryHtml = renderToStaticMarkup(
        React.createElement(
          UiDebugGallery as React.ComponentType<UiDebugGalleryProps>,
          { initialPreset: "blocked", initialMode: "live" }
        )
      );
      assert.ok(liveGalleryHtml.includes('data-testid="ui-debug-gallery"'));
      assert.ok(liveGalleryHtml.includes('data-ui-element="ui-debug-gallery"'));
      assert.ok(liveGalleryHtml.includes('data-ui-state="blocked"'));
      assert.ok(liveGalleryHtml.includes('data-testid="ui-debug-mode-fixtures"'));
      assert.ok(liveGalleryHtml.includes('data-testid="ui-debug-mode-live"'));
      assert.ok(liveGalleryHtml.includes('data-testid="ui-debug-live-inspector"'));
      assert.ok(liveGalleryHtml.includes('data-ui-element="ui-debug-live-inspector"'));
      assert.ok(liveGalleryHtml.includes('data-testid="live-inspector-refresh"'));
      assert.ok(liveGalleryHtml.includes('data-testid="live-inspector-autopoll"'));
      assert.ok(!liveGalleryHtml.includes("e3b0c442"));

      const pageEl = await DebugUiPage({
        searchParams: Promise.resolve({ uiDebug: "1", mode: "live" }),
      });
      const pageHtml = renderToStaticMarkup(pageEl);
      assert.ok(pageHtml.includes('data-testid="ui-debug-live-inspector"'));
      assert.ok(!pageHtml.includes("e3b0c442"));

      assert.equal(fetchCalled, false, "SSR render in live mode must never call fetch");
    });

    it("renders UiDebugBootstrap empty and UiDebugLiveHud / LiveStateInspector / useRunStream with zero SSR fetch", () => {
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        throw new Error("Network call should not happen during SSR");
      }) as typeof fetch;

      const bootstrapHtml = renderToStaticMarkup(
        React.createElement(UiDebugBootstrap)
      );
      assert.equal(bootstrapHtml, "");

      const hudHtml = renderToStaticMarkup(
        React.createElement(UiDebugLiveHud)
      );
      assert.ok(hudHtml.includes('data-testid="ui-debug-live-hud"'));
      assert.ok(hudHtml.includes('data-ui-element="ui-debug-live-hud"'));
      assert.ok(hudHtml.includes('data-testid="ui-debug-hud-toggle"'));
      assert.ok(!hudHtml.includes("e3b0c442"));

      const inspectorHtml = renderToStaticMarkup(
        React.createElement(LiveStateInspector)
      );
      assert.ok(inspectorHtml.includes('data-testid="ui-debug-live-inspector"'));
      assert.ok(!inspectorHtml.includes("e3b0c442"));

      function StreamProbe() {
        const s = useRunStream("run-ssr-stream-probe", { live: true });
        return React.createElement("span", null, s.view.phase);
      }
      const streamHtml = renderToStaticMarkup(React.createElement(StreamProbe));
      assert.ok(streamHtml.includes("unknown"));
      assert.equal(
        getLiveClientState().activeRuns.some(
          (r) => r.runId === "run-ssr-stream-probe"
        ),
        false
      );
      assert.equal(fetchCalled, false, "SSR render must never call fetch");
    });
  });
});
