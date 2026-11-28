import React from "react";
import { BuiltWithKiroView } from "@/components/BuiltWithKiroView";
import {
  loadEvidenceBundle,
  mapHistoryRun,
} from "@/lib/evidence/evidence-service";
import { listPublishedRuns } from "@/lib/history/published-runs";
import { resolveEventStore, resolveRunStore } from "@/lib/runtime/store-context";

export const dynamic = "force-dynamic";

export default async function BuiltWithKiroPage() {
  // Build-time evidence is read from disk. The runtime run list is read
  // in-process from the shared run/event stores (never over HTTP and never from
  // request headers), limited to the three most recent published runs with Kiro
  // fields, then handed to the evidence bundle already loaded.
  const runStore = resolveRunStore();
  const eventStore = resolveEventStore(undefined, undefined, runStore);
  const recentRuns = listPublishedRuns(runStore, eventStore, {
    limit: 3,
    fields: "kiro",
  }).map(mapHistoryRun);

  const bundle = await loadEvidenceBundle(
    process.cwd(),
    undefined,
    undefined,
    recentRuns
  );

  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8 font-mono">
      <div className="max-w-5xl mx-auto space-y-6">
        <BuiltWithKiroView bundle={bundle} />
      </div>
    </main>
  );
}
