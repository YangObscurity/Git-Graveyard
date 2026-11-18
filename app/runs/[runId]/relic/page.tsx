import React from "react";
import { ReliquaryView } from "@/components/ReliquaryView";

interface RelicPageProps {
  params: Promise<{
    runId: string;
  }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function RelicPage({ params }: RelicPageProps) {
  const resolvedParams = await params;
  const runId = resolvedParams.runId;

  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8 font-mono">
      <div className="max-w-5xl mx-auto space-y-8">
        {/* The outcome always comes from the recorded run, never from the URL. */}
        <ReliquaryView runId={runId} />
      </div>
    </main>
  );
}
