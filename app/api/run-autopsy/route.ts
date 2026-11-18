import { Readable } from "node:stream";
import { parseRepoInput, buildGithubUrl } from "@/lib/grimoire/normalize";
import {
  fetchRepoMetadata,
  fetchDefaultHead,
  type FetchImpl,
} from "@/lib/grimoire/github";
import {
  extractArchive,
  ArchiveError,
  type ExtractArchiveResult,
} from "@/lib/grimoire/archive";
import { scanInventory, type InventoryInputFile } from "@/lib/grimoire/detect";
import { detectSignals } from "@/lib/grimoire/signals";
import { computeVerdict } from "@/lib/grimoire/verdict";
import { formatAutopsy } from "@/lib/grimoire/autopsy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WATCHDOG_TIMEOUT_MS = 20000;
const MAX_COMPRESSED_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_DECOMPRESSED_BYTES = 60 * 1024 * 1024; // 60 MB
const MAX_ENTRIES = 2000;

function getAuthHeaders(): Record<string, string> {
  const token =
    typeof process !== "undefined" && process.env
      ? process.env.GITHUB_TOKEN
      : undefined;
  if (token && typeof token === "string" && token.trim().length > 0) {
    return {
      Authorization: `Bearer ${token.trim()}`,
    };
  }
  return {};
}

function toNodeReadable(body: unknown): Readable {
  if (!body) {
    return Readable.from([]);
  }
  if (typeof (body as any).pipe === "function") {
    return body as Readable;
  }
  if (
    typeof Readable.fromWeb === "function" &&
    typeof (body as any).getReader === "function"
  ) {
    return Readable.fromWeb(body as any);
  }
  if (typeof (body as any)[Symbol.asyncIterator] === "function") {
    return Readable.from(body as any);
  }
  return Readable.from([]);
}

export async function POST(request: Request): Promise<Response> {
  const requestTime = new Date();
  const startTime = Date.now();

  const abortController = new AbortController();
  let timedOut = false;
  const isTimedOut = () => timedOut || abortController.signal.aborted;

  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, WATCHDOG_TIMEOUT_MS);

  if (request.signal) {
    request.signal.addEventListener("abort", () => {
      abortController.abort();
    });
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { ok: false, code: "BAD_URL", message: "Invalid JSON body" },
        { status: 400 }
      );
    }

    if (!body || typeof body !== "object") {
      return Response.json(
        { ok: false, code: "BAD_URL", message: "Request body must be an object" },
        { status: 400 }
      );
    }

    const urlValue = (body as { url?: unknown }).url;
    if (typeof urlValue !== "string" || urlValue.trim().length === 0) {
      return Response.json(
        { ok: false, code: "BAD_URL", message: "url is required" },
        { status: 400 }
      );
    }

    const parseResult = parseRepoInput(urlValue);
    if (!parseResult.ok) {
      return Response.json(
        { ok: false, code: "BAD_URL", message: "Invalid repository URL" },
        { status: 400 }
      );
    }

    const { owner, repo } = parseResult;

    const baseFetch = (request as any).fetchImpl ?? globalThis.fetch;
    const customFetch: FetchImpl = (input: any, init?: any) => {
      return baseFetch(input, {
        ...init,
        signal: abortController.signal,
      });
    };

    // Stage 1: Fetch repository metadata
    const metaResult = await fetchRepoMetadata(owner, repo, customFetch);
    if (isTimedOut()) {
      return Response.json(
        { ok: false, code: "TIMEOUT", message: "Autopsy request timed out after 20 seconds" },
        { status: 504 }
      );
    }

    if (!metaResult.ok) {
      if (metaResult.code === "RATE_LIMITED") {
        return Response.json(
          {
            ok: false,
            code: "RATE_LIMITED",
            message: metaResult.message ?? "The GitHub API rate limit was exceeded.",
            resetAt: metaResult.resetAt,
            resetTime: metaResult.resetTime,
          },
          { status: 429 }
        );
      }
      if (metaResult.code === "REPO_NOT_FOUND") {
        return Response.json(
          {
            ok: false,
            code: "REPO_NOT_FOUND",
            message: metaResult.message ?? "The repository was not found or is private.",
          },
          { status: 404 }
        );
      }
      if (metaResult.code === "REPO_EMPTY") {
        return Response.json(
          {
            ok: false,
            code: "REPO_EMPTY",
            message: metaResult.message ?? "The repository default branch contains no commits.",
          },
          { status: 422 }
        );
      }
      return Response.json(
        {
          ok: false,
          code: "GITHUB_UNAVAILABLE",
          message: metaResult.message ?? "GitHub services are temporarily unavailable.",
        },
        { status: 502 }
      );
    }

    // Stage 1 (cont): Fetch default head commit
    const headResult = await fetchDefaultHead(
      owner,
      repo,
      metaResult.default_branch,
      customFetch
    );
    if (isTimedOut()) {
      return Response.json(
        { ok: false, code: "TIMEOUT", message: "Autopsy request timed out after 20 seconds" },
        { status: 504 }
      );
    }

    if (!headResult.ok) {
      if (headResult.code === "RATE_LIMITED") {
        return Response.json(
          {
            ok: false,
            code: "RATE_LIMITED",
            message: headResult.message ?? "The GitHub API rate limit was exceeded.",
            resetAt: headResult.resetAt,
            resetTime: headResult.resetTime,
          },
          { status: 429 }
        );
      }
      if (headResult.code === "REPO_NOT_FOUND") {
        return Response.json(
          {
            ok: false,
            code: "REPO_NOT_FOUND",
            message: headResult.message ?? "The repository was not found or is private.",
          },
          { status: 404 }
        );
      }
      if (headResult.code === "REPO_EMPTY") {
        return Response.json(
          {
            ok: false,
            code: "REPO_EMPTY",
            message: headResult.message ?? "The repository default branch contains no commits.",
          },
          { status: 422 }
        );
      }
      return Response.json(
        {
          ok: false,
          code: "GITHUB_UNAVAILABLE",
          message: headResult.message ?? "GitHub services are temporarily unavailable.",
        },
        { status: 502 }
      );
    }

    // Stage 1 (cont): Fetch tarball archive from codeload
    let codeloadUrl: string;
    try {
      codeloadUrl = buildGithubUrl("codeload", owner, repo, headResult.sha);
    } catch {
      return Response.json(
        { ok: false, code: "REPO_NOT_FOUND", message: "Invalid repository slug or sha" },
        { status: 404 }
      );
    }

    const codeloadHeaders: Record<string, string> = {
      "User-Agent": "Git-Graveyard",
      Accept: "application/x-gzip, application/octet-stream, */*",
      ...getAuthHeaders(),
    };

    let codeloadResponse: Response | undefined;
    let fail1 = false;
    try {
      codeloadResponse = await baseFetch(codeloadUrl, {
        method: "GET",
        headers: codeloadHeaders,
        signal: abortController.signal,
      });
      if (codeloadResponse && codeloadResponse.status >= 500 && codeloadResponse.status <= 599) {
        fail1 = true;
      }
    } catch {
      fail1 = true;
    }

    if (isTimedOut()) {
      return Response.json(
        { ok: false, code: "TIMEOUT", message: "Autopsy request timed out after 20 seconds" },
        { status: 504 }
      );
    }

    if (fail1) {
      let fail2 = false;
      try {
        codeloadResponse = await baseFetch(codeloadUrl, {
          method: "GET",
          headers: codeloadHeaders,
          signal: abortController.signal,
        });
        if (codeloadResponse && codeloadResponse.status >= 500 && codeloadResponse.status <= 599) {
          fail2 = true;
        }
      } catch {
        fail2 = true;
      }

      if (isTimedOut()) {
        return Response.json(
          { ok: false, code: "TIMEOUT", message: "Autopsy request timed out after 20 seconds" },
          { status: 504 }
        );
      }

      if (fail2 || !codeloadResponse) {
        return Response.json(
          {
            ok: false,
            code: "GITHUB_UNAVAILABLE",
            message: "GitHub codeload service is temporarily unavailable.",
          },
          { status: 502 }
        );
      }
    }

    if (!codeloadResponse) {
      return Response.json(
        {
          ok: false,
          code: "GITHUB_UNAVAILABLE",
          message: "GitHub codeload service is temporarily unavailable.",
        },
        { status: 502 }
      );
    }

    if (codeloadResponse.status === 404) {
      return Response.json(
        { ok: false, code: "REPO_NOT_FOUND", message: "Repository archive was not found." },
        { status: 404 }
      );
    }

    if (codeloadResponse.status === 429) {
      const resetHeader = codeloadResponse.headers.get("x-ratelimit-reset");
      const resetAt = resetHeader ? parseInt(resetHeader, 10) : undefined;
      return Response.json(
        {
          ok: false,
          code: "RATE_LIMITED",
          message: "GitHub rate limit exceeded during archive download.",
          resetAt: Number.isFinite(resetAt) ? resetAt : undefined,
          resetTime: resetHeader ?? undefined,
        },
        { status: 429 }
      );
    }

    if (codeloadResponse.status < 200 || codeloadResponse.status >= 300) {
      return Response.json(
        {
          ok: false,
          code: "GITHUB_UNAVAILABLE",
          message: `Unexpected status ${codeloadResponse.status} from codeload.`,
        },
        { status: 502 }
      );
    }

    const clHeader = codeloadResponse.headers.get("content-length");
    if (clHeader) {
      const compressedBytes = parseInt(clHeader, 10);
      if (Number.isFinite(compressedBytes) && compressedBytes > MAX_COMPRESSED_BYTES) {
        return Response.json(
          {
            ok: false,
            code: "TOO_LARGE",
            message: `Archive compressed size (${compressedBytes} bytes) exceeds limit of ${MAX_COMPRESSED_BYTES} bytes`,
          },
          { status: 413 }
        );
      }
    }

    // Extract archive with streaming and limits
    const elapsedMs = Date.now() - startTime;
    const remainingMs = Math.max(1, WATCHDOG_TIMEOUT_MS - elapsedMs);
    const archiveStream = toNodeReadable(codeloadResponse.body);

    let archiveResult: ExtractArchiveResult;
    try {
      archiveResult = await extractArchive(archiveStream, {
        maxCompressedBytes: MAX_COMPRESSED_BYTES,
        maxDecompressedBytes: MAX_DECOMPRESSED_BYTES,
        maxEntries: MAX_ENTRIES,
        timeoutMs: remainingMs,
        signal: abortController.signal,
      });
    } catch (err: unknown) {
      if (isTimedOut()) {
        return Response.json(
          { ok: false, code: "TIMEOUT", message: "Autopsy request timed out after 20 seconds" },
          { status: 504 }
        );
      }
      if (err instanceof ArchiveError) {
        const status =
          err.code === "TOO_LARGE" ? 413 : err.code === "TIMEOUT" ? 504 : 422;
        return Response.json(
          { ok: false, code: err.code, message: err.message, reason: err.reason },
          { status }
        );
      }
      return Response.json(
        {
          ok: false,
          code: "ARCHIVE_UNSAFE",
          message: err instanceof Error ? err.message : String(err),
        },
        { status: 422 }
      );
    }

    if (isTimedOut()) {
      return Response.json(
        { ok: false, code: "TIMEOUT", message: "Autopsy request timed out after 20 seconds" },
        { status: 504 }
      );
    }

    if (!archiveResult.ok) {
      const status =
        archiveResult.code === "TOO_LARGE"
          ? 413
          : archiveResult.code === "TIMEOUT"
          ? 504
          : 422;
      return Response.json(
        {
          ok: false,
          code: archiveResult.code,
          message: archiveResult.message,
          reason: archiveResult.reason,
        },
        { status }
      );
    }

    // Stage 2: Inventory and language detection
    const inventoryFiles = archiveResult.fileList as unknown as InventoryInputFile[];
    const invResult = scanInventory(inventoryFiles);
    if (!invResult.ok) {
      return Response.json(
        {
          ok: false,
          code: "LANGUAGE_UNKNOWN",
          message: invResult.message,
          lookedFor: invResult.lookedFor,
          filesLookedFor: invResult.filesLookedFor,
        },
        { status: 422 }
      );
    }

    // Stage 2 (cont): Signal detection
    const signalsResult = detectSignals(invResult.files, {
      unknowns: invResult.unknowns,
    });
    const signals = signalsResult.signals ?? Array.from(signalsResult);

    // Dead-or-alive verdict calculation
    const asOfTime = (body as any).asOf
      ? new Date((body as any).asOf)
      : requestTime;

    const verdict = computeVerdict({
      archived: metaResult.archived,
      lastCommitAt: headResult.lastCommitAt,
      createdAt: metaResult.created_at,
      signals,
      asOf: asOfTime,
      meta: metaResult,
      headCommit: headResult,
    });

    // Format autopsy result with template-only cause text
    const autopsy = formatAutopsy({
      archived: metaResult.archived,
      lastCommitAt: headResult.lastCommitAt,
      createdAt: metaResult.created_at,
      asOf: verdict.asOf,
      meta: metaResult,
      headCommit: headResult,
      signals,
      files: archiveResult,
      scannedFiles: invResult.files,
      inventory: invResult,
      languages: invResult.languages,
      verdict,
      commitMessage: headResult.message,
      sha: headResult.sha,
      fullName: metaResult.full_name,
      defaultBranch: metaResult.default_branch,
      stars: metaResult.stargazers_count,
      forks: metaResult.forks_count,
    });

    return Response.json(
      {
        ok: true,
        ...autopsy,
        meta: metaResult,
        signals,
      },
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
      }
    );
  } catch (error: unknown) {
    if (isTimedOut()) {
      return Response.json(
        { ok: false, code: "TIMEOUT", message: "Autopsy request timed out after 20 seconds" },
        { status: 504 }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { ok: false, code: "GITHUB_UNAVAILABLE", message },
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
