"use client";

import React from "react";
import Link from "next/link";
import { BuiltWithKiroEvidence } from "@/components/BuiltWithKiroEvidence";
import { CryptOrnament } from "@/components/ui/CryptOrnament";
import type { EvidenceBundle } from "@/lib/evidence/evidence-service";
import { routes } from "@/lib/ui/run-routes";

export interface BuiltWithKiroViewProps {
  bundle?: EvidenceBundle;
}

/**
 * The `/built-with-kiro` screen. It wraps the evidence renderer and guarantees
 * that any section whose source file is missing says "None found" instead of
 * inventing content: the build document and the runtime run list are both
 * reduced to empty arrays when their source is absent, and the evidence
 * component renders "None found" for every empty section.
 */
export function BuiltWithKiroView({ bundle }: BuiltWithKiroViewProps) {
  const build = bundle?.build;
  const runs = bundle?.recentRuns ?? [];

  const missingSections: string[] = [];
  if (!build || build.specs.length === 0) missingSections.push("specs");
  if (!build || build.steering.length === 0) missingSections.push("steering");
  if (!build || build.hooks.length === 0) missingSections.push("hooks");
  if (!build || build.agents.length === 0) missingSections.push("agents");
  if (runs.length === 0) missingSections.push("runtime runs");

  return (
    <div
      className="space-y-6 font-mono"
      data-testid="built-with-kiro-view"
      data-ui-element="built-with-kiro-view"
      data-ui-state="populated"
    >
      <header className="crypt-panel-engraved p-5 md:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="mt-0.5 p-2 rounded border border-[var(--necromancy-emerald-border)] bg-emerald-950/40 text-emerald-400">
              <CryptOrnament kind="arch-sigil" className="w-6 h-6" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-emerald-400/90 font-semibold">
                STAGE V · BUILT WITH KIRO
              </div>
              <h1 className="font-serif-ritual text-2xl md:text-3xl font-bold tracking-tight text-bone mt-0.5">
                Built with Kiro
              </h1>
              <p className="text-xs md:text-sm text-ash mt-1">
                Real build and runtime evidence, generated from files and recorded
                runs. A section with no source file says None found.
              </p>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-2 text-xs">
            <Link
              href={routes.history()}
              data-testid="built-with-kiro-history-link"
              className="crypt-btn-ghost px-3 py-1.5 rounded"
            >
              History Vault
            </Link>
            <Link
              href={routes.admin()}
              data-testid="built-with-kiro-admin-link"
              className="crypt-btn-ghost px-3 py-1.5 rounded"
            >
              Admin
            </Link>
          </nav>
        </div>
      </header>

      {missingSections.length > 0 && (
        <p
          data-testid="built-with-kiro-missing-sources"
          className="crypt-panel p-3.5 text-xs text-ash border-l-2 border-l-amber-400/70"
        >
          None found: {missingSections.join(", ")}.
        </p>
      )}

      <BuiltWithKiroEvidence bundle={bundle} />

      <footer className="space-y-4 pt-2">
        <CryptOrnament kind="divider" />
        <p className="text-xs text-dust text-center">
          Skeleton sessions run on Kiro CLI. Git-Graveyard is an independent project.
        </p>
      </footer>
    </div>
  );
}

export default BuiltWithKiroView;