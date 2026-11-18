import React from "react";
import { RunEntry } from "@/components/RunEntry";

interface RunEntryPageProps {
  params: Promise<{ runId: string }>;
}

export default async function RunEntryPage({ params }: RunEntryPageProps) {
  const { runId } = await params;

  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8 font-mono">
      <div className="max-w-2xl mx-auto">
        <RunEntry runId={runId} />
      </div>
    </main>
  );
}
