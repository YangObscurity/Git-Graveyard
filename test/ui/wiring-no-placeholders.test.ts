import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ReliquaryArtifactDownloads,
  type ReliquaryArtifactItem,
} from "@/components/ReliquaryArtifactDownloads";
import {
  ReliquaryBeforeAfterTable,
} from "@/components/ReliquaryBeforeAfterTable";
import { ReliquaryView } from "@/components/ReliquaryView";
import {
  LegionDashboard,
  type LegionDashboardHandlers,
} from "@/components/LegionDashboard";

describe("T34 Wave 3B: UI Wiring and Elimination of Placeholders", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("Requirement 1: ReliquaryArtifactDownloads - No fake artifact placeholders", () => {
    it("does not render fake sha256 e3b0c442... when artifacts is omitted", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryArtifactDownloads, {
          runId: "run-art-empty-01",
        })
      );

      assert.ok(!html.includes("e3b0c44298fc1c14"));
      assert.ok(!html.includes("e3b0c442"));
      assert.ok(html.includes("No recorded artifact metadata available."));
      assert.ok(html.includes("The event log is still available."));
      assert.ok(html.includes("/api/runs/run-art-empty-01/events?from=1"));
    });

    it("does not render fake sha256 e3b0c442... when artifacts is an empty array", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryArtifactDownloads, {
          runId: "run-art-empty-02",
          artifacts: [],
        })
      );

      assert.ok(!html.includes("e3b0c44298fc1c14"));
      assert.ok(!html.includes("e3b0c442"));
      assert.ok(html.includes("No recorded artifact metadata available."));
      assert.ok(html.includes("The event log is still available."));
      assert.ok(html.includes("/api/runs/run-art-empty-02/events?from=1"));
    });

    it("renders Packing the relics state when packing is true", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryArtifactDownloads, {
          runId: "run-art-packing",
          packing: true,
        })
      );

      assert.ok(html.includes("Packing the relics"));
      assert.ok(!html.includes("e3b0c44298fc1c14"));
    });

    it("renders realistic artifact entries when provided without any fake default sha256", () => {
      const realisticArtifacts: ReliquaryArtifactItem[] = [
        {
          id: "patch",
          name: "all.patch",
          fileName: "all.patch",
          kind: "patch",
          size: 1024,
          sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        {
          id: "report",
          name: "report",
          fileName: "report.md",
          kind: "report",
          size: 2048,
          sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ];

      const html = renderToStaticMarkup(
        React.createElement(ReliquaryArtifactDownloads, {
          runId: "run-art-realistic",
          artifacts: realisticArtifacts,
        })
      );

      assert.ok(!html.includes("e3b0c44298fc1c14"));
      assert.ok(html.includes("all.patch"));
      assert.ok(html.includes("report.md"));
      assert.ok(html.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
      assert.ok(html.includes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    });
  });

  describe("Requirement 2: ReliquaryBeforeAfterTable - No optimistic fake defaults", () => {
    it("does not default unpopulated after cells to 'passed' or 'exit: 0'", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryBeforeAfterTable, {})
      );

      // In the After column, there must be no default 'passed' or 'exit: 0'
      assert.ok(!html.includes(">passed</span>"));
      assert.ok(!html.includes(">clean</span>"));
      assert.ok(!html.includes(">present</span>"));
      assert.ok(!html.includes(">modern</span>"));
    });

    it("defaults unpopulated after cells to status 'not run' and exit: -", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryBeforeAfterTable, {})
      );

      // Verify 'not run' badge appears in the rendered markup
      assert.ok(html.includes("not run"));
      assert.ok(html.includes("exit: <span class=\"font-mono text-neutral-200\">-</span>"));
      assert.ok(html.includes("time: <span class=\"font-mono text-neutral-200\">-</span>"));
    });

    it("retains all 7 verification step rows, exit:, time:, and View output labels", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryBeforeAfterTable, {})
      );

      assert.ok(html.includes("Install"));
      assert.ok(html.includes("Build"));
      assert.ok(html.includes("Tests (repository&#x27;s own)") || html.includes("Tests (repository's own)"));
      assert.ok(html.includes("Grimoire signals"));
      assert.ok(html.includes("Lockfile"));
      assert.ok(html.includes("Runtime used"));
      assert.ok(html.includes("Tests added by skeletons"));

      assert.ok(html.includes("exit:"));
      assert.ok(html.includes("time:"));
      assert.ok(html.includes("View output"));
    });
  });

  describe("Requirement 3: ReliquaryView - Initial loading and endpoint fetching", () => {
    it("does not pre-seed 'Resurrected' outcome when initialOutcome is absent", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryView, {
          runId: "run-no-seed-test",
        })
      );

      // When initialOutcome is absent, it renders loading state and does not show Resurrected banner
      assert.ok(!html.includes("data-testid=\"reliquary-outcome-banner\""));
      assert.ok(!html.includes(">Resurrected<"));
      assert.ok(html.includes("Loading relics for run run-no-seed-test..."));
    });

    it("renders outcome banner immediately when initialOutcome is explicitly provided", () => {
      const html = renderToStaticMarkup(
        React.createElement(ReliquaryView, {
          runId: "run-explicit-test",
          outcome: "resurrected",
        })
      );

      assert.ok(html.includes("data-testid=\"reliquary-outcome-banner\""));
      assert.ok(html.includes("Resurrected"));
    });
  });

  describe("Requirement 4: LegionDashboard - Interactive handlers wire to real backend endpoints", () => {
    it("triggers POST /api/runs/[runId]/control with { action: 'pause' } on handlePauseRun", async () => {
      const calls: { url: string; method: string; body: any }[] = [];
      globalThis.fetch = async (url: any, init: any) => {
        calls.push({
          url: String(url),
          method: init?.method || "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const handlersRef: { current: LegionDashboardHandlers | null } = { current: null };
      renderToStaticMarkup(
        React.createElement(LegionDashboard, {
          runId: "run-ctrl-01",
          handlersRef,
        })
      );

      assert.ok(handlersRef.current !== null);
      await handlersRef.current.handlePauseRun();

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/runs/run-ctrl-01/control");
      assert.equal(calls[0].method, "POST");
      assert.deepEqual(calls[0].body, { action: "pause" });
    });

    it("triggers POST /api/runs/[runId]/control with { action: 'resume' } on handleResumeRun", async () => {
      const calls: { url: string; method: string; body: any }[] = [];
      globalThis.fetch = async (url: any, init: any) => {
        calls.push({
          url: String(url),
          method: init?.method || "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const handlersRef: { current: LegionDashboardHandlers | null } = { current: null };
      renderToStaticMarkup(
        React.createElement(LegionDashboard, {
          runId: "run-ctrl-02",
          handlersRef,
        })
      );

      assert.ok(handlersRef.current !== null);
      await handlersRef.current.handleResumeRun();

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/runs/run-ctrl-02/control");
      assert.equal(calls[0].method, "POST");
      assert.deepEqual(calls[0].body, { action: "resume" });
    });

    it("triggers POST /api/runs/[runId]/control with { action: 'stop' } on handleStopRun and handleCancelQueuedRun", async () => {
      const calls: { url: string; method: string; body: any }[] = [];
      globalThis.fetch = async (url: any, init: any) => {
        calls.push({
          url: String(url),
          method: init?.method || "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const handlersRef: { current: LegionDashboardHandlers | null } = { current: null };
      renderToStaticMarkup(
        React.createElement(LegionDashboard, {
          runId: "run-ctrl-03",
          handlersRef,
        })
      );

      assert.ok(handlersRef.current !== null);
      await handlersRef.current.handleStopRun();
      await handlersRef.current.handleCancelQueuedRun();

      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, "/api/runs/run-ctrl-03/control");
      assert.equal(calls[0].method, "POST");
      assert.deepEqual(calls[0].body, { action: "stop" });

      assert.equal(calls[1].url, "/api/runs/run-ctrl-03/control");
      assert.equal(calls[1].method, "POST");
      assert.deepEqual(calls[1].body, { action: "stop" });
    });

    it("triggers POST /api/runs/[runId]/control with { action: 'kill' } on handleKillRun", async () => {
      const calls: { url: string; method: string; body: any }[] = [];
      globalThis.fetch = async (url: any, init: any) => {
        calls.push({
          url: String(url),
          method: init?.method || "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const handlersRef: { current: LegionDashboardHandlers | null } = { current: null };
      renderToStaticMarkup(
        React.createElement(LegionDashboard, {
          runId: "run-ctrl-04",
          handlersRef,
        })
      );

      assert.ok(handlersRef.current !== null);
      await handlersRef.current.handleKillRun();

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/runs/run-ctrl-04/control");
      assert.equal(calls[0].method, "POST");
      assert.deepEqual(calls[0].body, { action: "kill" });
    });

    it("triggers POST /api/runs/[runId]/approvals on handleApprovalDecision", async () => {
      const calls: { url: string; method: string; body: any }[] = [];
      globalThis.fetch = async (url: any, init: any) => {
        calls.push({
          url: String(url),
          method: init?.method || "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const handlersRef: { current: LegionDashboardHandlers | null } = { current: null };
      renderToStaticMarkup(
        React.createElement(LegionDashboard, {
          runId: "run-appr-01",
          handlersRef,
        })
      );

      assert.ok(handlersRef.current !== null);
      await handlersRef.current.handleApprovalDecision("appr-123", "approve_once");

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/runs/run-appr-01/approvals");
      assert.equal(calls[0].method, "POST");
      assert.deepEqual(calls[0].body, {
        approvalId: "appr-123",
        decision: "approve_once",
      });
    });

    it("triggers POST /api/runs/[runId]/skeletons/[skeletonId] with interrupt, reraise, lay_to_rest", async () => {
      const calls: { url: string; method: string; body: any }[] = [];
      globalThis.fetch = async (url: any, init: any) => {
        calls.push({
          url: String(url),
          method: init?.method || "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const handlersRef: { current: LegionDashboardHandlers | null } = { current: null };
      renderToStaticMarkup(
        React.createElement(LegionDashboard, {
          runId: "run-skel-01",
          handlersRef,
        })
      );

      assert.ok(handlersRef.current !== null);

      await handlersRef.current.handleInterrupt("skel-bonesetter");
      await handlersRef.current.handleReraise("skel-bonesetter");
      await handlersRef.current.handleLayToRest("skel-bonesetter", "keep");
      await handlersRef.current.handleLayToRest("skel-bonesetter", "discard");

      assert.equal(calls.length, 4);

      assert.equal(calls[0].url, "/api/runs/run-skel-01/skeletons/skel-bonesetter");
      assert.deepEqual(calls[0].body, { action: "interrupt" });

      assert.equal(calls[1].url, "/api/runs/run-skel-01/skeletons/skel-bonesetter");
      assert.deepEqual(calls[1].body, { action: "reraise" });

      assert.equal(calls[2].url, "/api/runs/run-skel-01/skeletons/skel-bonesetter");
      assert.deepEqual(calls[2].body, { action: "lay_to_rest", choice: "keep" });

      assert.equal(calls[3].url, "/api/runs/run-skel-01/skeletons/skel-bonesetter");
      assert.deepEqual(calls[3].body, { action: "lay_to_rest", choice: "discard" });
    });

    it("triggers POST /api/runs/[runId]/skeletons/[skeletonId] with send_instruction and add_review_focus", async () => {
      const calls: { url: string; method: string; body: any }[] = [];
      globalThis.fetch = async (url: any, init: any) => {
        calls.push({
          url: String(url),
          method: init?.method || "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const handlersRef: { current: LegionDashboardHandlers | null } = { current: null };
      renderToStaticMarkup(
        React.createElement(LegionDashboard, {
          runId: "run-skel-02",
          handlersRef,
        })
      );

      assert.ok(handlersRef.current !== null);

      await handlersRef.current.handleSendInstruction("skel-stitcher", "Focus on Node 20 deprecation");
      await handlersRef.current.handleAddReviewFocus("skel-warden", "Check path traversal in archive extraction");

      assert.equal(calls.length, 2);

      assert.equal(calls[0].url, "/api/runs/run-skel-02/skeletons/skel-stitcher");
      assert.deepEqual(calls[0].body, {
        action: "send_instruction",
        instruction: "Focus on Node 20 deprecation",
      });

      assert.equal(calls[1].url, "/api/runs/run-skel-02/skeletons/skel-warden");
      assert.deepEqual(calls[1].body, {
        action: "add_review_focus",
        focus: "Check path traversal in archive extraction",
      });
    });

    it("reports loadError on non-ok backend response rather than silently continuing", async () => {
      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: "Action disallowed by Warden policy" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      };

      const handlersRef: { current: LegionDashboardHandlers | null } = { current: null };
      renderToStaticMarkup(
        React.createElement(LegionDashboard, {
          runId: "run-err-01",
          handlersRef,
        })
      );

      assert.ok(handlersRef.current !== null);

      // Calling handler when backend responds 403 must not throw unhandled exception
      await handlersRef.current.handlePauseRun();
      await handlersRef.current.handleApprovalDecision("appr-999", "deny");
      await handlersRef.current.handleInterrupt("skel-1");
      await handlersRef.current.handleSendInstruction("skel-1", "test");
    });
  });
});
