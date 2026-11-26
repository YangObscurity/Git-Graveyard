import React from "react";
import { LegionDashboard } from "@/components/LegionDashboard";

interface LegionPageProps {
  params: Promise<{ runId: string }> | { runId: string };
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }> | { [key: string]: string | string[] | undefined };
}

export default async function LegionPage({
  params,
  searchParams,
}: LegionPageProps) {
  const resolvedParams = await Promise.resolve(params);
  const resolvedSearchParams = searchParams ? await Promise.resolve(searchParams) : undefined;

  const runId = resolvedParams.runId || "";
  const adminParam = resolvedSearchParams?.admin;
  const isAdmin = adminParam === "true" || adminParam === "1";

  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8 font-mono">
      <div className="max-w-6xl mx-auto space-y-6">
        <LegionDashboard runId={runId} isAdmin={isAdmin} />
      </div>
    </main>
  );
}
