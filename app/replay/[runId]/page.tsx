import React from "react";
import { ReplayPlayer } from "@/components/ReplayPlayer";

interface ReplayPageProps {
  params: Promise<{ runId: string }> | { runId: string };
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }> | { [key: string]: string | string[] | undefined };
}

export default async function ReplayPage({
  params,
  searchParams,
}: ReplayPageProps) {
  const resolvedParams = await Promise.resolve(params);
  const resolvedSearchParams = searchParams ? await Promise.resolve(searchParams) : undefined;

  const runId = resolvedParams.runId || "";

  let from: number | undefined = undefined;
  let to: number | undefined = undefined;

  if (resolvedSearchParams?.from) {
    const rawFrom = Array.isArray(resolvedSearchParams.from)
      ? resolvedSearchParams.from[0]
      : resolvedSearchParams.from;
    const parsed = parseInt(String(rawFrom), 10);
    if (!Number.isNaN(parsed)) {
      from = parsed;
    }
  }

  if (resolvedSearchParams?.to) {
    const rawTo = Array.isArray(resolvedSearchParams.to)
      ? resolvedSearchParams.to[0]
      : resolvedSearchParams.to;
    const parsed = parseInt(String(rawTo), 10);
    if (!Number.isNaN(parsed)) {
      to = parsed;
    }
  }

  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone font-mono">
      <ReplayPlayer runId={runId} from={from} to={to} />
    </main>
  );
}
