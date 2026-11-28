/**
 * Runtime loader for Kiro evidence (Task 26.3 / Requirements 48.7-48.10).
 *
 * Loads the build-time `public/kiro-evidence.json` and merges it with the three
 * most recent published runs' Skeleton records fetched from
 * `GET /api/history?fields=kiro`.
 *
 * Server-side callers can read the JSON straight from disk with `fs`; client-side
 * callers fall back to `fetch("/kiro-evidence.json")`. Node built-ins are loaded
 * dynamically inside the server-only branch so client bundles never pull them in.
 */

export interface EvidenceSpec {
  path: string;
  name: string;
}

export interface EvidenceSteering {
  path: string;
  name: string;
  inclusion: "always" | "fileMatch" | "manual" | "unknown";
}

export interface EvidenceHook {
  name: string;
  trigger: string;
  matcher?: string;
  command?: string;
}

export interface EvidencePermissionRule {
  capability: string;
  effect: string;
  match?: string[];
}

export interface EvidenceAgent {
  path: string;
  name: string;
  description: string;
  modelTier?: string;
  policyPreset?: string;
  tools: string[];
  excludedTools: string[];
  permissions: EvidencePermissionRule[];
}

export interface EvidenceCommitLink {
  sha: string;
  shortSha: string;
  subject: string;
  refs: string;
}

export interface KiroEvidenceDoc {
  schemaVersion: string;
  generatedFromSha: string;
  specs: EvidenceSpec[];
  steering: EvidenceSteering[];
  hooks: EvidenceHook[];
  agents: EvidenceAgent[];
  commitLinks: EvidenceCommitLink[];
}

/** One Skeleton record extracted from a published run. */
export interface SkeletonRecord {
  role: string;
  agentName: string;
  modelId: string;
  kiroCliVersion: string;
  sessionId: string;
  timestamp: number;
}

/** A published run reduced to the fields the evidence page renders. */
export interface PublishedRunEvidence {
  runId: string;
  repository: string;
  outcome: string | null;
  date: string;
  skeletons: SkeletonRecord[];
}

export interface EvidenceBundle {
  build: KiroEvidenceDoc;
  recentRuns: PublishedRunEvidence[];
}

const EMPTY_BUILD: KiroEvidenceDoc = {
  schemaVersion: "v1",
  generatedFromSha: "",
  specs: [],
  steering: [],
  hooks: [],
  agents: [],
  commitLinks: [],
};

function normalizeDoc(raw: unknown): KiroEvidenceDoc {
  if (!raw || typeof raw !== "object") return { ...EMPTY_BUILD };
  const obj = raw as Record<string, unknown>;
  const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    schemaVersion: typeof obj.schemaVersion === "string" ? obj.schemaVersion : "v1",
    generatedFromSha:
      typeof obj.generatedFromSha === "string" ? obj.generatedFromSha : "",
    specs: asArray<EvidenceSpec>(obj.specs),
    steering: asArray<EvidenceSteering>(obj.steering),
    hooks: asArray<EvidenceHook>(obj.hooks),
    agents: asArray<EvidenceAgent>(obj.agents),
    commitLinks: asArray<EvidenceCommitLink>(obj.commitLinks),
  };
}

/**
 * Load the build-time evidence document.
 * - Server-side (Node): reads `public/kiro-evidence.json` from disk.
 * - Client-side: fetches `/kiro-evidence.json`.
 * Returns an empty-but-valid document if the source is missing.
 */
export async function loadBuildEvidence(
  repoRoot: string | undefined = typeof process !== "undefined" ? process.cwd() : undefined
): Promise<KiroEvidenceDoc> {
  if (repoRoot && typeof process !== "undefined" && process.versions?.node) {
    try {
      const [{ existsSync, readFileSync }, path] = await Promise.all([
        import("node:fs"),
        import("node:path"),
      ]);
      const abs = path.join(repoRoot, "public", "kiro-evidence.json");
      if (existsSync(abs)) {
        const parsed = JSON.parse(readFileSync(abs, "utf8"));
        return normalizeDoc(parsed);
      }
    } catch {
      // fall through to fetch
    }
  }
  if (typeof fetch === "function") {
    try {
      const res = await fetch("/kiro-evidence.json");
      if (res.ok) {
        const parsed = await res.json();
        return normalizeDoc(parsed);
      }
    } catch {
      // ignore
    }
  }
  return { ...EMPTY_BUILD };
}

interface RawSkeleton {
  role?: unknown;
  agentName?: unknown;
  agent?: unknown;
  modelId?: unknown;
  model?: unknown;
  kiroCliVersion?: unknown;
  version?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  timestamp?: unknown;
  ts?: unknown;
}

interface RawHistoryRun {
  runId?: unknown;
  repository?: unknown;
  repo?: unknown;
  outcome?: unknown;
  date?: unknown;
  createdAt?: unknown;
  skeletons?: unknown;
}

function toStringValue(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function toNumberValue(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Reduce one raw history run (fields=kiro) to a PublishedRunEvidence. */
export function mapHistoryRun(raw: RawHistoryRun): PublishedRunEvidence {
  const skeletonsRaw = Array.isArray(raw.skeletons) ? (raw.skeletons as RawSkeleton[]) : [];
  const skeletons: SkeletonRecord[] = skeletonsRaw.map((s) => ({
    role: toStringValue(s.role),
    agentName: toStringValue(s.agentName ?? s.agent),
    modelId: toStringValue(s.modelId ?? s.model),
    kiroCliVersion: toStringValue(s.kiroCliVersion ?? s.version),
    sessionId: toStringValue(s.sessionId ?? s.session_id),
    // A skeleton without a valid numeric timestamp falls back to 0 so the
    // component renders "None found" rather than inheriting the run's createdAt.
    timestamp: toNumberValue(s.timestamp ?? s.ts, 0),
  }));
  return {
    runId: toStringValue(raw.runId),
    repository: toStringValue(raw.repository ?? raw.repo),
    outcome: raw.outcome === null || raw.outcome === undefined ? null : toStringValue(raw.outcome),
    date: toStringValue(raw.date),
    skeletons,
  };
}

/**
 * Fetch the three most recent published runs' Skeleton records from
 * `GET /api/history?fields=kiro`. When `baseUrl` is a non-empty origin it is
 * used as the request prefix (with any trailing slashes trimmed) so server-side
 * callers can pass an explicit origin; otherwise the relative path is used.
 * Returns [] on any failure (never throws).
 */
export async function fetchRecentKiroRuns(
  limit = 3,
  fetchImpl: typeof fetch | undefined = typeof fetch === "function" ? fetch : undefined,
  baseUrl?: string
): Promise<PublishedRunEvidence[]> {
  if (!fetchImpl) return [];
  try {
    const base = typeof baseUrl === "string" ? baseUrl.replace(/\/+$/, "") : "";
    const path = `/api/history?fields=kiro&limit=${limit}`;
    const url = base.length > 0 ? `${base}${path}` : path;
    const res = await fetchImpl(url);
    if (!res.ok) return [];
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) return [];
    return (json as RawHistoryRun[]).slice(0, limit).map(mapHistoryRun);
  } catch {
    return [];
  }
}

/** Load build evidence and merge the three most recent published runs.
 *
 * When `preloadedRecentRuns` is supplied (for example by a server-rendered page
 * that already listed the runs in-process), they are used as-is and no fetch is
 * performed; otherwise the runs are fetched from `GET /api/history?fields=kiro`.
 */
export async function loadEvidenceBundle(
  repoRoot?: string,
  fetchImpl?: typeof fetch,
  baseUrl?: string,
  preloadedRecentRuns?: PublishedRunEvidence[]
): Promise<EvidenceBundle> {
  const build = await loadBuildEvidence(repoRoot);
  const recentRuns =
    preloadedRecentRuns !== undefined
      ? preloadedRecentRuns
      : await fetchRecentKiroRuns(3, fetchImpl, baseUrl);
  return { build, recentRuns };
}