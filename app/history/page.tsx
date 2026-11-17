import React from "react";
import { HistoryList } from "@/components/HistoryList";
import { CryptOrnament } from "@/components/ui/CryptOrnament";

export default function HistoryPage() {
  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8 font-mono">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="crypt-panel-engraved p-5 md:p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3.5">
              <div className="mt-0.5 p-2 rounded border border-[var(--necromancy-emerald-border)] bg-emerald-950/40 text-emerald-400">
                <CryptOrnament kind="arch-sigil" className="w-6 h-6" />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-emerald-400/90 font-semibold">
                  STAGE VI · HISTORY VAULT
                </div>
                <h1 className="font-serif-ritual text-2xl md:text-3xl font-bold tracking-tight text-bone mt-0.5">
                  Recorded Run History
                </h1>
                <p className="text-xs md:text-sm text-ash mt-1">
                  Published resurrection runs. Real recorded runs replayed exactly as they happened.
                </p>
              </div>
            </div>
          </div>
        </header>

        <section>
          <HistoryList />
        </section>

        <footer className="space-y-4 pt-4">
          <CryptOrnament kind="divider" />
          <p className="text-xs text-dust text-center">
            Skeleton sessions run on Kiro CLI. Git-Graveyard is an independent project.
          </p>
        </footer>
      </div>
    </main>
  );
}
