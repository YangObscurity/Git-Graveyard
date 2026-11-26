"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  DEBUG_PRESET_MODES,
  DEBUG_VIEWPORT_MODES,
  SHOWCASE_SECTIONS,
  THEME_SWATCHES,
  getUiFixturesForPreset,
  type DebugPresetMode,
  type DebugViewportMode,
  type ShowcaseSectionId,
} from "@/lib/debug/ui-fixtures";
import { CryptOrnament } from "@/components/ui/CryptOrnament";
import { StatusPill } from "@/components/ui/StatusPill";
import { HealthBadge } from "@/components/HealthBadge";
import { SignalChip, type SignalChipData } from "@/components/SignalChip";
import { CommandRow } from "@/components/CommandRow";
import { ReceiptViewer } from "@/components/ReceiptViewer";
import { DeathCertificateView } from "@/components/DeathCertificateView";
import { PactBudgetSettings } from "@/components/PactBudgetSettings";
import { PactDiff } from "@/components/PactDiff";
import { PactEditor } from "@/components/PactEditor";
import { LegionRunHeader } from "@/components/LegionRunHeader";
import { LegionSkeletonCard } from "@/components/LegionSkeletonCard";
import { LegionWaitingRoomCard } from "@/components/LegionWaitingRoomCard";
import { LegionApprovalCard } from "@/components/LegionApprovalCard";
import { LegionAskCard } from "@/components/LegionAskCard";
import { ReliquaryView } from "@/components/ReliquaryView";
import { ReliquaryBeforeAfterTable } from "@/components/ReliquaryBeforeAfterTable";
import { ReliquaryArtifactDownloads } from "@/components/ReliquaryArtifactDownloads";
import { LiveStateInspector } from "@/components/debug/LiveStateInspector";

export type UiDebugGalleryMode = "fixtures" | "live";

export interface UiDebugGalleryProps {
  initialPreset?: DebugPresetMode;
  initialViewport?: DebugViewportMode;
  initialElement?: string;
  initialOutline?: boolean;
  initialMode?: UiDebugGalleryMode;
}

const VIEWPORT_CONTAINER_CLASS: Record<DebugViewportMode, string> = {
  full: "w-full max-w-none",
  tablet: "w-full max-w-[768px] mx-auto border border-emerald-500/25 rounded-lg p-3 bg-abyss/60",
  mobile: "w-full max-w-[375px] mx-auto border border-amber-500/30 rounded-lg p-2.5 bg-abyss/60",
};

const VIEWPORT_LABEL: Record<DebugViewportMode, string> = {
  full: "Full Width",
  tablet: "Tablet (768px)",
  mobile: "Mobile (375px)",
};

function isValidPreset(value: string | null | undefined): value is DebugPresetMode {
  return Boolean(value && (DEBUG_PRESET_MODES as readonly string[]).includes(value));
}

function isValidViewport(value: string | null | undefined): value is DebugViewportMode {
  return Boolean(value && (DEBUG_VIEWPORT_MODES as readonly string[]).includes(value));
}

function mapElementSlugToSection(slug?: string): ShowcaseSectionId | "all" {
  if (!slug) return "all";
  const s = slug.toLowerCase();
  if (s === "all") return "all";
  if (s.includes("token") || s.includes("ornament")) return "tokens";
  if (s.includes("health") || s.includes("status") || s.includes("signal") || s.includes("command") || s === "badges") {
    return "badges";
  }
  if (s.includes("death") || s.includes("receipt") || s === "tomb") return "tomb";
  if (s.includes("pact")) return "pact";
  if (s.includes("legion")) return "legion";
  if (s.includes("reliquary") || s.includes("relic") || s.includes("artifact")) return "reliquary";
  return "all";
}

export function UiDebugGallery({
  initialPreset = "active",
  initialViewport = "full",
  initialElement = "",
  initialOutline = false,
  initialMode = "fixtures",
}: UiDebugGalleryProps = {}) {
  const [mode, setMode] = useState<UiDebugGalleryMode>(
    initialMode === "live" ? "live" : "fixtures"
  );
  const [preset, setPreset] = useState<DebugPresetMode>(
    isValidPreset(initialPreset) ? initialPreset : "active"
  );
  const [viewport, setViewport] = useState<DebugViewportMode>(
    isValidViewport(initialViewport) ? initialViewport : "full"
  );
  const [activeSection, setActiveSection] = useState<ShowcaseSectionId | "all">(
    mapElementSlugToSection(initialElement)
  );
  const [focusedElementSlug, setFocusedElementSlug] = useState<string>(initialElement);
  const [outlineEnabled, setOutlineEnabled] = useState<boolean>(initialOutline);
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);
  const [pactCycleMode, setPactCycleMode] = useState<boolean>(false);
  const [activeReceipt, setActiveReceipt] = useState<SignalChipData | null>(null);
  const [actionLog, setActionLog] = useState<string[]>([
    "[lab] Initialized zero-network UI showcase fixtures",
  ]);

  function pushLog(entry: string) {
    setActionLog((prev) => [`[${preset}] ${entry}`, ...prev].slice(0, 20));
  }

  // Sync deep-link query params safely client-side (SSR-safe)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const qState = params.get("state");
      const qViewport = params.get("viewport");
      const qElement = params.get("element");
      const qUiDebug = params.get("uiDebug");
      const qMode = params.get("mode");

      if (qMode === "live" || qMode === "fixtures") {
        setMode(qMode);
      }
      if (isValidPreset(qState)) {
        setPreset(qState);
      }
      if (isValidViewport(qViewport)) {
        setViewport(qViewport);
      }
      if (qElement) {
        setFocusedElementSlug(qElement);
        setActiveSection(mapElementSlugToSection(qElement));
      }
      if (qUiDebug === "1") {
        setOutlineEnabled(true);
        window.__GIT_GRAVEYARD_UI_DEBUG__?.setOutlineOverlay(true);
      }
    } catch {
      // Ignore query parsing issues
    }
  }, []);

  const fixtures = useMemo(() => getUiFixturesForPreset(preset), [preset]);

  function handleToggleOutline() {
    const next = !outlineEnabled;
    setOutlineEnabled(next);
    if (typeof window !== "undefined") {
      window.__GIT_GRAVEYARD_UI_DEBUG__?.setOutlineOverlay(next);
    }
    pushLog(`Outline overlay -> ${next ? "enabled" : "disabled"}`);
  }

  function handleToggleReducedMotion() {
    const next = !reducedMotion;
    setReducedMotion(next);
    if (typeof window !== "undefined") {
      window.__GIT_GRAVEYARD_UI_DEBUG__?.setReducedMotionPreview(next);
    }
    pushLog(`Reduced motion preview -> ${next ? "enabled" : "disabled"}`);
  }

  function handleSelectPreset(nextPreset: DebugPresetMode) {
    setPreset(nextPreset);
    setActionLog((prev) => [`[${nextPreset}] Switched global state matrix`, ...prev].slice(0, 20));
  }

  const showSection = (id: ShowcaseSectionId) =>
    activeSection === "all" || activeSection === id;

  return (
    <div
      data-testid="ui-debug-gallery"
      data-ui-element="ui-debug-gallery"
      data-ui-state={preset}
      data-ui-variant={viewport}
      className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6 font-mono text-bone"
    >
      {/* Header Banner */}
      <header className="crypt-panel-engraved p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded border border-[var(--necromancy-emerald-border)] bg-emerald-950/40 text-emerald-400">
              <CryptOrnament kind="arch-sigil" className="w-6 h-6" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-emerald-400 font-semibold">
                SYNTHETIC ZERO-NETWORK SHOWCASE LAB
              </div>
              <h1 className="font-serif-ritual text-2xl md:text-3xl font-bold text-bone">
                Cryptic Gothic Terminal · UI &amp; State Matrix
              </h1>
              <p className="text-xs text-ash mt-1">
                Inspect design tokens, ornaments, and component states offline with deterministic fixtures.
                {focusedElementSlug ? (
                  <span className="ml-2 text-emerald-300">
                    Deep-link target: <code>{focusedElementSlug}</code>
                  </span>
                ) : null}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="ui-debug-outline-toggle"
              onClick={handleToggleOutline}
              className={
                outlineEnabled
                  ? "crypt-btn-primary px-3 py-1.5 rounded text-xs"
                  : "crypt-btn-ghost px-3 py-1.5 rounded text-xs"
              }
            >
              {outlineEnabled ? "Outline Inspector: ON" : "Outline Inspector: OFF"}
            </button>
            <button
              type="button"
              data-testid="ui-debug-motion-toggle"
              onClick={handleToggleReducedMotion}
              className={
                reducedMotion
                  ? "crypt-btn-primary px-3 py-1.5 rounded text-xs"
                  : "crypt-btn-ghost px-3 py-1.5 rounded text-xs"
              }
            >
              {reducedMotion ? "Reduced Motion: ON" : "Reduced Motion: OFF"}
            </button>
          </div>
        </div>

        {/* Top-Level Mode Switcher Tabs */}
        <div
          className="pt-3 border-t border-white/10 flex flex-wrap items-center gap-2"
          role="tablist"
          aria-label="UI Debug Lab mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "fixtures"}
            data-testid="ui-debug-mode-fixtures"
            onClick={() => {
              setMode("fixtures");
              pushLog("Switched mode -> Synthetic Fixture Matrix");
            }}
            className={
              mode === "fixtures"
                ? "crypt-btn-primary px-3 py-1.5 rounded text-xs"
                : "crypt-btn-ghost px-3 py-1.5 rounded text-xs"
            }
          >
            Synthetic Fixture Matrix
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "live"}
            data-testid="ui-debug-mode-live"
            onClick={() => {
              setMode("live");
              pushLog("Switched mode -> Live Runtime Inspector");
            }}
            className={
              mode === "live"
                ? "crypt-btn-primary px-3 py-1.5 rounded text-xs"
                : "crypt-btn-ghost px-3 py-1.5 rounded text-xs"
            }
          >
            Live Runtime Inspector
          </button>
        </div>

        {/* Controls Toolbar: Global State Matrix + Viewport Previewer + Section Jump */}
        {mode === "fixtures" && (
        <div className="pt-4 border-t border-white/10 grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* 1. Global State Matrix Switcher */}
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-dust">
              Global State Matrix
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="State matrix presets">
              {DEBUG_PRESET_MODES.map((mode) => {
                const isActive = preset === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    data-testid={`ui-debug-preset-${mode}`}
                    onClick={() => handleSelectPreset(mode)}
                    className={`px-2.5 py-1 rounded text-xs border transition-colors cursor-pointer ${
                      isActive
                        ? "bg-emerald-950/60 border-[var(--necromancy-emerald-border)] text-emerald-300 font-semibold"
                        : "bg-neutral-900/80 border-white/10 text-ash hover:text-bone hover:border-white/25"
                    }`}
                  >
                    {mode}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Viewport Width Previewer */}
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-dust">
              Viewport Width Previewer
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Viewport width preview">
              {DEBUG_VIEWPORT_MODES.map((vp) => {
                const isActive = viewport === vp;
                return (
                  <button
                    key={vp}
                    type="button"
                    data-testid={`ui-debug-viewport-${vp}`}
                    onClick={() => {
                      setViewport(vp);
                      pushLog(`Viewport frame -> ${VIEWPORT_LABEL[vp]}`);
                    }}
                    className={`px-2.5 py-1 rounded text-xs border transition-colors cursor-pointer ${
                      isActive
                        ? "bg-amber-950/50 border-[var(--arcane-amber-border)] text-amber-300 font-semibold"
                        : "bg-neutral-900/80 border-white/10 text-ash hover:text-bone hover:border-white/25"
                    }`}
                  >
                    {VIEWPORT_LABEL[vp]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Section Filter */}
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-dust">
              Showcase Section
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setActiveSection("all");
                  setFocusedElementSlug("");
                }}
                className={`px-2 py-1 rounded text-[11px] border cursor-pointer ${
                  activeSection === "all"
                    ? "bg-emerald-950/60 border-[var(--necromancy-emerald-border)] text-emerald-300 font-semibold"
                    : "bg-neutral-900/80 border-white/10 text-ash hover:text-bone"
                }`}
              >
                All (6)
              </button>
              {SHOWCASE_SECTIONS.map((sec) => (
                <button
                  key={sec.id}
                  type="button"
                  onClick={() => {
                    setActiveSection(sec.id);
                    setFocusedElementSlug(sec.id);
                  }}
                  className={`px-2 py-1 rounded text-[11px] border cursor-pointer ${
                    activeSection === sec.id
                      ? "bg-emerald-950/60 border-[var(--necromancy-emerald-border)] text-emerald-300 font-semibold"
                      : "bg-neutral-900/80 border-white/10 text-ash hover:text-bone"
                  }`}
                >
                  {sec.id}
                </button>
              ))}
            </div>
          </div>
        </div>
        )}
      </header>

      {mode === "live" ? (
        <LiveStateInspector />
      ) : (
        <>
          {/* Interactive Action Log Panel */}
      <section className="crypt-panel p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs uppercase tracking-wider text-ash font-semibold">
            Synthetic Action Log (Zero-Network Callback Inspector)
          </h2>
          <button
            type="button"
            onClick={() => setActionLog([])}
            className="text-[11px] text-dust hover:text-bone cursor-pointer"
          >
            Clear Log
          </button>
        </div>
        <div
          data-testid="ui-debug-action-log"
          className="crypt-well p-2.5 max-h-28 overflow-y-auto text-[11px] text-parchment space-y-1"
        >
          {actionLog.length === 0 ? (
            <div className="text-dust italic">No interactions recorded yet.</div>
          ) : (
            actionLog.map((line, idx) => (
              <div key={idx} className="truncate">
                {line}
              </div>
            ))
          )}
        </div>
      </section>

      {/* Responsive Preview Frame */}
      <div className={VIEWPORT_CONTAINER_CLASS[viewport]}>
        <div className="space-y-8">
          {/* SECTION 1: Tokens & Ornaments */}
          {showSection("tokens") && (
            <section
              data-testid="ui-debug-section-tokens"
              className="crypt-panel p-5 space-y-5"
            >
              <div className="border-b border-white/10 pb-3">
                <h2 className="text-sm font-bold text-bone uppercase tracking-wider">
                  1. Tokens, Surfaces &amp; Ornaments
                </h2>
                <p className="text-xs text-ash mt-0.5">
                  Obsidian basalt swatches, inline SVG gothic sigils, and ritual button classes.
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {THEME_SWATCHES.map((swatch) => (
                  <div key={swatch.name} className="crypt-well p-2.5 space-y-1.5">
                    <div
                      className="h-7 rounded border border-white/15"
                      style={{ backgroundColor: swatch.hex }}
                    />
                    <div className="text-[11px] font-semibold text-bone truncate">
                      {swatch.name}
                    </div>
                    <div className="text-[10px] text-dust flex justify-between">
                      <span>{swatch.hex}</span>
                      <span>{swatch.role}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {(
                  [
                    "arch-sigil",
                    "tomb-arch",
                    "wax-seal",
                    "skeleton-skull",
                    "divider",
                    "corner-ticks",
                  ] as const
                ).map((kind) => (
                  <div
                    key={kind}
                    className="crypt-well relative p-4 flex flex-col items-center justify-center gap-2 min-h-24 text-emerald-400"
                  >
                    <CryptOrnament kind={kind} />
                    <span className="text-[10px] text-ash uppercase">{kind}</span>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => pushLog("Clicked .crypt-btn-primary")}
                  className="crypt-btn-primary px-3.5 py-1.5 rounded text-xs"
                >
                  Primary Ritual CTA
                </button>
                <button
                  type="button"
                  onClick={() => pushLog("Clicked .crypt-btn-ghost")}
                  className="crypt-btn-ghost px-3.5 py-1.5 rounded text-xs"
                >
                  Ghost Action
                </button>
                <button
                  type="button"
                  onClick={() => pushLog("Clicked .crypt-btn-danger")}
                  className="crypt-btn-danger px-3.5 py-1.5 rounded text-xs"
                >
                  Crimson Seal
                </button>
                <span className="crypt-kbd">Space</span>
                <span className="crypt-kbd">←/→</span>
              </div>
            </section>
          )}

          {/* SECTION 2: Badges, Signals & Terminal Rows */}
          {showSection("badges") && (
            <section
              data-testid="ui-debug-section-badges"
              className="crypt-panel p-5 space-y-5"
            >
              <div className="border-b border-white/10 pb-3">
                <h2 className="text-sm font-bold text-bone uppercase tracking-wider">
                  2. Badges, Signals &amp; Terminal Rows
                </h2>
                <p className="text-xs text-ash mt-0.5">
                  Controlled HealthBadge verdicts, StatusPill tones, SignalChips, and CommandRow states.
                </p>
              </div>

              <div className="space-y-3">
                <div className="text-[11px] uppercase tracking-wider text-dust">
                  HealthBadge Verdicts
                </div>
                <div className="flex flex-wrap gap-2.5">
                  {fixtures.healthBadges.map((hb, i) => (
                    <HealthBadge key={i} {...hb} />
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <div className="text-[11px] uppercase tracking-wider text-dust">
                  StatusPill Semantic Tones
                </div>
                <div className="flex flex-wrap gap-2.5">
                  {fixtures.statusPills.map((sp, i) => (
                    <StatusPill key={i} {...sp} />
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <div className="text-[11px] uppercase tracking-wider text-dust">
                  Grimoire SignalChips (click target to inspect ReceiptViewer)
                </div>
                <div className="flex flex-wrap gap-2.5">
                  {fixtures.signalChips.map((chip, i) => (
                    <SignalChip
                      key={i}
                      chip={chip}
                      sha="9f3c1b2a84e7d601"
                      onOpenReceipt={(opened) => {
                        setActiveReceipt(opened);
                        pushLog(`Opened ReceiptViewer for ${opened.ruleId} (${opened.file}:${opened.line})`);
                      }}
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-2.5">
                <div className="text-[11px] uppercase tracking-wider text-dust">
                  CommandRow Terminal Strips
                </div>
                {fixtures.commandRows.map((row, i) => (
                  <CommandRow
                    key={row.id ?? i}
                    row={row}
                    onViewOutput={(r) => pushLog(`Toggled CommandRow output: ${r.command}`)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* SECTION 3: Tomb & Autopsy Fixtures */}
          {showSection("tomb") && (
            <section
              data-testid="ui-debug-section-tomb"
              className="crypt-panel p-5 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
                <div>
                  <h2 className="text-sm font-bold text-bone uppercase tracking-wider">
                    3. Tomb &amp; Forensic Autopsy Fixtures
                  </h2>
                  <p className="text-xs text-ash mt-0.5">
                    DeathCertificateView with verifiable file:line citations and ReceiptViewer modal trigger.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setActiveReceipt(fixtures.receiptChip);
                    pushLog("Opened ReceiptViewer modal from Tomb section");
                  }}
                  className="crypt-btn-ghost px-3 py-1.5 rounded text-xs"
                >
                  Open ReceiptViewer Modal
                </button>
              </div>

              <DeathCertificateView
                certificate={fixtures.deathCertificate}
                runId="debug-run-01"
                onNavigateToPact={(id) => pushLog(`DeathCertificateView -> Draft Pact (${id ?? "debug"})`)}
                onStopHere={() => pushLog("DeathCertificateView -> Stop Here")}
              />
            </section>
          )}

          {/* SECTION 4: Pact Workbench Fixtures */}
          {showSection("pact") && (
            <section
              data-testid="ui-debug-section-pact"
              className="crypt-panel p-5 space-y-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
                <div>
                  <h2 className="text-sm font-bold text-bone uppercase tracking-wider">
                    4. Necromancer&apos;s Pact Workbench Fixtures
                  </h2>
                  <p className="text-xs text-ash mt-0.5">
                    PactBudgetSettings, PactDiff, and PactEditor with toggleable dependency cycle.
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="ui-debug-toggle-cycle"
                  onClick={() => {
                    setPactCycleMode((prev) => {
                      const next = !prev;
                      pushLog(`PactEditor DAG mode -> ${next ? "CYCLE" : "VALID"}`);
                      return next;
                    });
                  }}
                  className={
                    pactCycleMode
                      ? "crypt-btn-danger px-3 py-1.5 rounded text-xs"
                      : "crypt-btn-ghost px-3 py-1.5 rounded text-xs"
                  }
                >
                  {pactCycleMode ? "Cycle Mode: ON (T1 ↔ T2)" : "Cycle Mode: OFF (Valid DAG)"}
                </button>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <PactBudgetSettings
                  key={`budget-${preset}`}
                  {...fixtures.pactBudget}
                  onChange={(b) => pushLog(`Budget updated: ${b.maxMinutes}m, ${b.maxParallel} parallel`)}
                />
                <PactDiff {...fixtures.pactDiff} />
              </div>

              <PactEditor
                key={`pact-editor-${preset}-${pactCycleMode ? "cycle" : "valid"}`}
                runId="debug-run-01"
                initialData={
                  pactCycleMode
                    ? fixtures.pactEditorWithCycle
                    : fixtures.pactEditorValid
                }
                onApprove={() => pushLog("PactEditor -> Approve triggered")}
                onNavigateToLegion={(id) => pushLog(`PactEditor -> Navigate Legion (${id})`)}
              />
            </section>
          )}

          {/* SECTION 5: Legion Tactical Fixtures */}
          {showSection("legion") && (
            <section
              data-testid="ui-debug-section-legion"
              className="crypt-panel p-5 space-y-5"
            >
              <div className="border-b border-white/10 pb-3">
                <h2 className="text-sm font-bold text-bone uppercase tracking-wider">
                  5. Skeleton Legion Tactical Fixtures
                </h2>
                <p className="text-xs text-ash mt-0.5">
                  LegionRunHeader, LegionSkeletonCard lifecycle variants, Waiting Room, and Warden Approval Card.
                </p>
              </div>

              <LegionRunHeader {...fixtures.legionHeader} />

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {fixtures.skeletons.map((skel) => (
                  <LegionSkeletonCard
                    key={skel.skeletonId}
                    skeleton={skel}
                    onSendInstruction={(id, text) =>
                      pushLog(`Send instruction -> ${id}${text ? `: ${text}` : ""}`)
                    }
                    onInterrupt={(id) => pushLog(`Interrupt -> ${id}`)}
                    onReraise={(id) => pushLog(`Reraise -> ${id}`)}
                    onLayToRest={(id, choice) => pushLog(`Lay to rest (${choice}) -> ${id}`)}
                    onAddReviewFocus={(id, focus) =>
                      pushLog(`Add review focus -> ${id}${focus ? `: ${focus}` : ""}`)
                    }
                  />
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <LegionWaitingRoomCard
                  {...fixtures.waitingRoom}
                  onCancel={() => pushLog("WaitingRoom -> Cancel queued run")}
                />
                <LegionApprovalCard
                  approval={fixtures.approval}
                  onDecision={(id, decision) =>
                    pushLog(`ApprovalCard (${id}) -> ${decision}`)
                  }
                />
              </div>

              <LegionAskCard
                ask={fixtures.ask}
                onAnswer={(id, answer) => {
                  pushLog(`AskCard (${id}) -> ${answer}`);
                  return true;
                }}
              />
            </section>
          )}

          {/* SECTION 6: Reliquary & Vault Fixtures */}
          {showSection("reliquary") && (
            <section
              data-testid="ui-debug-section-reliquary"
              className="crypt-panel p-5 space-y-5"
            >
              <div className="border-b border-white/10 pb-3">
                <h2 className="text-sm font-bold text-bone uppercase tracking-wider">
                  6. Reliquary &amp; Vault Fixtures
                </h2>
                <p className="text-xs text-ash mt-0.5">
                  ReliquaryView outcome banners, Before/After matrix, and Artifact Downloads (zero fake SHA-256).
                </p>
              </div>

              <ReliquaryView
                key={`reliquary-${preset}`}
                {...fixtures.reliquaryView}
              />

              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-wider text-dust">
                  Standalone ReliquaryBeforeAfterTable Matrix
                </div>
                <ReliquaryBeforeAfterTable {...fixtures.beforeAfterTable} />
              </div>

              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-wider text-dust">
                  Standalone ReliquaryArtifactDownloads
                </div>
                <ReliquaryArtifactDownloads {...fixtures.artifactDownloads} />
              </div>
            </section>
          )}
        </div>
      </div>

      {/* ReceiptViewer Modal */}
      {activeReceipt && (
        <ReceiptViewer
          chip={activeReceipt}
          sha="9f3c1b2a84e7d601"
          onClose={() => {
            setActiveReceipt(null);
            pushLog("Closed ReceiptViewer modal");
          }}
        />
      )}
        </>
      )}
    </div>
  );
}
