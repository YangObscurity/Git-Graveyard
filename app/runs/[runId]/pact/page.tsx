import React from "react";
import { PactEditor } from "@/components/PactEditor";

interface PactPageProps {
  params: Promise<{ runId: string }> | { runId: string };
  searchParams?:
    | Promise<{ [key: string]: string | string[] | undefined }>
    | { [key: string]: string | string[] | undefined };
}

export default async function PactPage({
  params,
  searchParams,
}: PactPageProps) {
  const resolvedParams = await Promise.resolve(params);
  const resolvedSearch = searchParams
    ? await Promise.resolve(searchParams)
    : {};

  const runId = resolvedParams?.runId || "";
  const codeParam = resolvedSearch?.code ?? resolvedSearch?.inviteCode;
  const inviteCode =
    typeof codeParam === "string"
      ? codeParam
      : Array.isArray(codeParam)
      ? codeParam[0]
      : undefined;

  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8 font-mono">
      <div className="max-w-5xl mx-auto space-y-8">
        <PactEditor runId={runId} inviteCode={inviteCode} />
      </div>
    </main>
  );
}
