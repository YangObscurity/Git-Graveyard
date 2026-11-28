import React from "react";
import { headers } from "next/headers";
import { BuiltWithKiroView } from "@/components/BuiltWithKiroView";
import { loadEvidenceBundle } from "@/lib/evidence/evidence-service";
import { buildRequestBaseUrl } from "@/lib/ui/admin-api";

export const dynamic = "force-dynamic";

export default async function BuiltWithKiroPage() {
  // Build-time evidence is read from disk; the runtime run list is fetched from
  // the history endpoint. A server-side fetch of a relative path cannot resolve,
  // so an absolute base URL is built from the request headers. When the headers
  // are unavailable the base URL stays undefined and the run list stays empty.
  let baseUrl: string | undefined;
  try {
    const requestHeaders = await headers();
    baseUrl = buildRequestBaseUrl(requestHeaders) ?? undefined;
  } catch {
    baseUrl = undefined;
  }

  const bundle = await loadEvidenceBundle(process.cwd(), fetch, baseUrl);

  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8 font-mono">
      <div className="max-w-5xl mx-auto space-y-6">
        <BuiltWithKiroView bundle={bundle} />
      </div>
    </main>
  );
}