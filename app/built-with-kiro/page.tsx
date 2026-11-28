import React from "react";
import { BuiltWithKiroView } from "@/components/BuiltWithKiroView";
import { loadEvidenceBundle } from "@/lib/evidence/evidence-service";

export const dynamic = "force-dynamic";

export default async function BuiltWithKiroPage() {
  // Build-time evidence is read from disk; the runtime run list is empty when
  // no history endpoint is reachable, so the page never invents a run.
  const bundle = await loadEvidenceBundle(process.cwd());

  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8 font-mono">
      <div className="max-w-5xl mx-auto space-y-6">
        <BuiltWithKiroView bundle={bundle} />
      </div>
    </main>
  );
}