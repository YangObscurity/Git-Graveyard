import React from "react";
import { TombstoneView } from "@/components/TombstoneView";

interface TombPageProps {
  params: Promise<{
    owner: string;
    repo: string;
  }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function TombPage({
  params,
  searchParams,
}: TombPageProps) {
  const resolvedParams = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8 font-mono">
      <div className="max-w-4xl mx-auto space-y-8">
        <TombstoneView
          owner={resolvedParams.owner}
          repo={resolvedParams.repo}
          searchParams={resolvedSearchParams}
        />
      </div>
    </main>
  );
}
