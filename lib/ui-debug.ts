export interface UiDebugElementSnapshot {
  element: string;
  state: string | null;
  variant: string | null;
  testId: string | null;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

export interface LiveRunStreamSnapshot {
  runId: string;
  loading: boolean;
  reconnecting: boolean;
  loadError: string | null;
  lastSeq: number;
  phase: string;
  outcome: string | null;
  pactStatus: string;
  pactVersion: number | null;
  skeletonCount: number;
  pendingApprovalsCount: number;
  openAsksCount: number;
  taskCount: number;
  updatedAt: number;
}

export type LiveRunStreamSnapshotInput =
  | LiveRunStreamSnapshot
  | (Omit<LiveRunStreamSnapshot, "runId" | "updatedAt"> & {
      runId?: string;
      updatedAt?: number;
    });

export interface LiveClientState {
  isBrowser: boolean;
  pathname: string;
  search: string;
  uiDebugActive: boolean;
  outlineOverlay: boolean;
  reducedMotionPreview: boolean;
  activeRuns: LiveRunStreamSnapshot[];
  updatedAt: number | null;
}

export interface HealthDetailPayload {
  status?: string;
  liveRunStatus?: string;
  reason?: string;
  queueLength?: number;
  badgeText?: string;
  ok?: boolean;
  engineVersion?: string;
  diagnostics?: Record<string, unknown>;
}

export interface BackendDebugRecentRun {
  runId: string;
  repository?: string | null;
  phase?: string | null;
  outcome?: string | null;
  isPublished?: boolean;
  isRemoved?: boolean;
  eventCount?: number;
  lastSeq?: number;
  lastEventKind?: string | null;
  updatedAt?: number | null;
}

export interface BackendDebugDiagnostics {
  timestamp: string | number;
  engineVersion: string;
  nodeVersion: string;
  platform: string;
  nodeEnv: string;
  health: {
    status: string;
    ok: boolean;
    reason?: string;
    queueLength: number;
    badgeText: string;
  };
  stores: {
    runStore: {
      storageMode: string;
      totalRuns: number;
      livingRunsCount: number;
      publishedRunsCount: number;
      activeLiveRunsCount: number;
      inviteCodesSummary?: unknown;
    };
    eventStore: {
      storageMode: string;
      totalEvents: number;
      distinctRunCount: number;
    };
    recordedRuns: {
      availableOnDisk: unknown[];
      seededRunIds: string[];
    };
  };
  admission: {
    paused: boolean;
    unavailable: boolean;
    healthy: boolean;
    reason?: string;
    queueLength: number;
    queueDepthCap: number;
    liveCapacity: number;
    activeLiveRunIds: string[];
    queuedRuns: unknown[];
  };
  runtimeHost: {
    initialized: boolean;
    stopped: boolean;
    paused: boolean;
    gatewayServerListening: boolean;
    gatewayPort: number | null;
    backendKind: string;
    supervisorsCount: number;
    pendingApprovalsCount: number;
  };
  orchestrator: {
    initialized: boolean;
    activeRunIds: string[];
    queuedRunIds: string[];
    activeHandles: unknown;
  };
  probes: {
    sourcePresent: boolean;
    devAllowed: boolean;
    prodAllowed: boolean;
    settledByFallback: boolean;
    blocking: unknown;
  };
  toolchains?: Record<string, unknown>;
  envPresence: Record<string, unknown>;
  recentRuns: BackendDebugRecentRun[];
}

export interface BackendDebugStatusResponse {
  ok: boolean;
  code?: string;
  error?: string;
  diagnostics?: BackendDebugDiagnostics;
}

export interface BackendDebugRunResponse {
  ok: boolean;
  code?: string;
  error?: string;
  runId?: string;
  run?: Record<string, unknown> | null;
  sequenceIntegrity?: {
    eventCount: number;
    firstSeq: number | null;
    lastSeq: number | null;
    missingSeqGaps: unknown[];
  };
  countsByKind?: Record<string, number>;
  countsByActor?: Record<string, number>;
  phaseParity?: {
    runStorePhase: string | null;
    reducedViewPhase: string | null;
    parityOk: boolean;
  };
  reducedView?: Record<string, unknown> | null;
  activeHandle?: Record<string, unknown> | null;
  artifacts?: unknown;
  latestEvents?: Array<Record<string, unknown>>;
}

export interface BackendDiagnosticsResult {
  ok: boolean;
  statusCode: number | null;
  locked: boolean;
  error: string | null;
  status: BackendDebugStatusResponse | null;
  run: BackendDebugRunResponse | null;
  fetchedAt: number;
}

export interface UiDebugPageInspection {
  client: LiveClientState;
  domElements: UiDebugElementSnapshot[];
  themeTokens: Record<string, string>;
  backend: BackendDiagnosticsResult;
}

export interface GitGraveyardUiDebugApi {
  version: "1.0.0";
  listElements: () => UiDebugElementSnapshot[];
  getElementsBySlug: (slug: string) => UiDebugElementSnapshot[];
  setOutlineOverlay: (enabled: boolean) => void;
  setReducedMotionPreview: (enabled: boolean) => void;
  getThemeTokens: () => Record<string, string>;
  getLiveClientState: () => LiveClientState;
  fetchBackendDiagnostics: (opts?: {
    runId?: string;
    probeToolchains?: boolean;
  }) => Promise<BackendDiagnosticsResult>;
  inspectCurrentPage: (opts?: {
    runId?: string;
    probeToolchains?: boolean;
  }) => Promise<UiDebugPageInspection>;
}

type UiDebugStateListener = (state: LiveClientState) => void;

interface UiDebugSharedStore {
  runs: Map<string, LiveRunStreamSnapshot>;
  listeners: Set<UiDebugStateListener>;
  lastUpdatedAt: number | null;
}

const UI_DEBUG_STORE_SYMBOL = Symbol.for("git-graveyard.ui-debug.shared-store");

declare global {
  interface Window {
    __GIT_GRAVEYARD_UI_DEBUG__?: GitGraveyardUiDebugApi;
  }
}

function getSharedStore(): UiDebugSharedStore {
  const g = globalThis as unknown as Record<symbol, UiDebugSharedStore | undefined>;
  let store = g[UI_DEBUG_STORE_SYMBOL];
  if (!store) {
    store = {
      runs: new Map<string, LiveRunStreamSnapshot>(),
      listeners: new Set<UiDebugStateListener>(),
      lastUpdatedAt: null,
    };
    g[UI_DEBUG_STORE_SYMBOL] = store;
  }
  return store;
}

function notifyListeners(): void {
  const store = getSharedStore();
  if (store.listeners.size === 0) {
    return;
  }
  const snapshot = getLiveClientState();
  for (const listener of store.listeners) {
    try {
      listener(snapshot);
    } catch {
      // Ignore subscriber errors so one listener never disrupts others.
    }
  }
}

export function getLiveClientState(): LiveClientState {
  const store = getSharedStore();
  const activeRuns = Array.from(store.runs.values())
    .map((entry) => ({ ...entry }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const isBrowser =
    typeof window !== "undefined" && typeof document !== "undefined";

  let pathname = "/";
  let search = "";
  let uiDebugActive = false;
  let outlineOverlay = false;
  let reducedMotionPreview = false;

  if (isBrowser) {
    try {
      pathname = window.location?.pathname || "/";
      search = window.location?.search || "";
      const params = new URLSearchParams(search);
      uiDebugActive = params.get("uiDebug") === "1";
    } catch {
      // Ignore malformed location/search strings
    }

    try {
      const rootEl = document.documentElement;
      outlineOverlay = rootEl?.getAttribute("data-ui-debug-outline") === "true";
      reducedMotionPreview =
        rootEl?.getAttribute("data-ui-reduced-motion") === "true";
    } catch {
      // Ignore DOM attribute read errors
    }
  }

  return {
    isBrowser,
    pathname,
    search,
    uiDebugActive,
    outlineOverlay,
    reducedMotionPreview,
    activeRuns,
    updatedAt: store.lastUpdatedAt,
  };
}

export function reportLiveRunStreamSnapshot(
  runId: string,
  snapshot: LiveRunStreamSnapshotInput
): void {
  const trimmed = typeof runId === "string" ? runId.trim() : "";
  if (!trimmed) {
    return;
  }

  const store = getSharedStore();
  const now =
    typeof snapshot.updatedAt === "number" && Number.isFinite(snapshot.updatedAt)
      ? snapshot.updatedAt
      : Date.now();

  const normalized: LiveRunStreamSnapshot = {
    runId: trimmed,
    loading: Boolean(snapshot.loading),
    reconnecting: Boolean(snapshot.reconnecting),
    loadError: snapshot.loadError ?? null,
    lastSeq: typeof snapshot.lastSeq === "number" ? snapshot.lastSeq : 0,
    phase: typeof snapshot.phase === "string" ? snapshot.phase : "unknown",
    outcome: snapshot.outcome ?? null,
    pactStatus:
      typeof snapshot.pactStatus === "string" ? snapshot.pactStatus : "none",
    pactVersion:
      typeof snapshot.pactVersion === "number" ? snapshot.pactVersion : null,
    skeletonCount:
      typeof snapshot.skeletonCount === "number" ? snapshot.skeletonCount : 0,
    pendingApprovalsCount:
      typeof snapshot.pendingApprovalsCount === "number"
        ? snapshot.pendingApprovalsCount
        : 0,
    openAsksCount:
      typeof snapshot.openAsksCount === "number" ? snapshot.openAsksCount : 0,
    taskCount: typeof snapshot.taskCount === "number" ? snapshot.taskCount : 0,
    updatedAt: now,
  };

  store.runs.set(trimmed, normalized);
  store.lastUpdatedAt = now;
  notifyListeners();
}

export function clearLiveRunStreamSnapshot(runId: string): void {
  const trimmed = typeof runId === "string" ? runId.trim() : "";
  if (!trimmed) {
    return;
  }
  const store = getSharedStore();
  if (store.runs.delete(trimmed)) {
    store.lastUpdatedAt = Date.now();
    notifyListeners();
  }
}

export function subscribeUiDebugState(
  listener: UiDebugStateListener
): () => void {
  const store = getSharedStore();
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

async function safeJsonFetch<T>(
  url: string
): Promise<{
  ok: boolean;
  statusCode: number | null;
  data: T | null;
  error: string | null;
}> {
  if (typeof fetch !== "function") {
    return {
      ok: false,
      statusCode: null,
      data: null,
      error: "fetch is not available in this environment",
    };
  }

  try {
    const res = await fetch(url, { cache: "no-store" });
    let data: T | null = null;
    try {
      data = (await res.json()) as T;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const errObj = data as { error?: string; code?: string } | null;
      return {
        ok: false,
        statusCode: res.status,
        data,
        error:
          errObj?.error ??
          (res.status === 403
            ? "Debug endpoint locked (403)"
            : res.status === 404
            ? "Debug endpoint not found (404)"
            : `HTTP ${res.status}`),
      };
    }
    return {
      ok: true,
      statusCode: res.status,
      data,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      data: null,
      error: err instanceof Error ? err.message : "Network request failed",
    };
  }
}

export async function fetchBackendDiagnostics(opts?: {
  runId?: string;
  probeToolchains?: boolean;
}): Promise<BackendDiagnosticsResult> {
  const statusParams = new URLSearchParams({ uiDebug: "1" });
  if (opts?.probeToolchains) {
    statusParams.set("probeToolchains", "1");
  }
  const statusUrl = `/api/debug/status?${statusParams.toString()}`;
  const trimmedRunId = opts?.runId?.trim();
  const runUrl = trimmedRunId
    ? `/api/debug/runs/${encodeURIComponent(trimmedRunId)}?uiDebug=1`
    : null;

  const [statusRes, runRes] = await Promise.all([
    safeJsonFetch<BackendDebugStatusResponse>(statusUrl),
    runUrl
      ? safeJsonFetch<BackendDebugRunResponse>(runUrl)
      : Promise.resolve(null),
  ]);

  const locked =
    statusRes.statusCode === 403 ||
    statusRes.data?.code === "DEBUG_LOCKED" ||
    runRes?.statusCode === 403;

  return {
    ok: statusRes.ok && (runRes ? runRes.ok : true),
    statusCode: statusRes.statusCode,
    locked,
    error: statusRes.error ?? runRes?.error ?? null,
    status: statusRes.data,
    run: runRes ? runRes.data : null,
    fetchedAt: Date.now(),
  };
}

function inferRunIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/(?:runs|replay)\/([^/]+)/);
  if (!match) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

const THEME_TOKEN_KEYS = [
  "--bg-abyss",
  "--bg-crypt",
  "--bg-slab",
  "--bg-slab-hover",
  "--bg-recessed",
  "--bg-glass",
  "--fg-bone",
  "--fg-parchment",
  "--fg-ash",
  "--fg-dust",
  "--border-hairline",
  "--border-engraved",
  "--border-focus",
  "--necromancy-emerald",
  "--necromancy-emerald-bright",
  "--necromancy-emerald-dim",
  "--necromancy-emerald-border",
  "--arcane-amber",
  "--arcane-amber-bright",
  "--arcane-amber-dim",
  "--arcane-amber-border",
  "--crimson-seal",
  "--crimson-seal-bright",
  "--crimson-seal-dim",
  "--crimson-seal-border",
  "--spectral-violet",
  "--spectral-violet-dim",
  "--spectral-violet-border",
] as const;

function snapshotElement(el: Element): UiDebugElementSnapshot {
  const domRect = el.getBoundingClientRect();
  let visible = domRect.width > 0 && domRect.height > 0;

  if (
    visible &&
    typeof window !== "undefined" &&
    typeof window.getComputedStyle === "function"
  ) {
    const styles = window.getComputedStyle(el);
    if (
      styles.display === "none" ||
      styles.visibility === "hidden" ||
      styles.opacity === "0"
    ) {
      visible = false;
    }
  }

  return {
    element: el.getAttribute("data-ui-element") ?? "",
    state: el.getAttribute("data-ui-state"),
    variant: el.getAttribute("data-ui-variant"),
    testId: el.getAttribute("data-testid"),
    rect: {
      x: Math.round(domRect.x * 100) / 100,
      y: Math.round(domRect.y * 100) / 100,
      width: Math.round(domRect.width * 100) / 100,
      height: Math.round(domRect.height * 100) / 100,
    },
    visible,
  };
}

export function createUiDebugApi(): GitGraveyardUiDebugApi {
  const listElements = (): UiDebugElementSnapshot[] => {
    if (typeof document === "undefined") {
      return [];
    }
    return Array.from(document.querySelectorAll("[data-ui-element]")).map(
      snapshotElement
    );
  };

  const getElementsBySlug = (slug: string): UiDebugElementSnapshot[] => {
    if (typeof document === "undefined" || !slug) {
      return [];
    }
    return Array.from(document.querySelectorAll("[data-ui-element]"))
      .filter((el) => el.getAttribute("data-ui-element") === slug)
      .map(snapshotElement);
  };

  const setOutlineOverlay = (enabled: boolean): void => {
    if (typeof document === "undefined") {
      return;
    }
    if (enabled) {
      document.documentElement.setAttribute("data-ui-debug-outline", "true");
    } else {
      document.documentElement.removeAttribute("data-ui-debug-outline");
    }
    notifyListeners();
  };

  const setReducedMotionPreview = (enabled: boolean): void => {
    if (typeof document === "undefined") {
      return;
    }
    if (enabled) {
      document.documentElement.setAttribute("data-ui-reduced-motion", "true");
    } else {
      document.documentElement.removeAttribute("data-ui-reduced-motion");
    }
    notifyListeners();
  };

  const getThemeTokens = (): Record<string, string> => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return {};
    }
    const computed = window.getComputedStyle(document.documentElement);
    const tokens: Record<string, string> = {};
    for (const key of THEME_TOKEN_KEYS) {
      const value = computed.getPropertyValue(key).trim();
      if (value) {
        tokens[key] = value;
      }
    }
    return tokens;
  };

  const inspectCurrentPage = async (opts?: {
    runId?: string;
    probeToolchains?: boolean;
  }): Promise<UiDebugPageInspection> => {
    const client = getLiveClientState();
    const domElements = listElements();
    const themeTokens = getThemeTokens();
    const targetRunId =
      opts?.runId?.trim() ||
      client.activeRuns[0]?.runId ||
      inferRunIdFromPath(client.pathname);

    const backend = await fetchBackendDiagnostics({
      runId: targetRunId,
      probeToolchains: opts?.probeToolchains,
    });

    return {
      client,
      domElements,
      themeTokens,
      backend,
    };
  };

  return {
    version: "1.0.0",
    listElements,
    getElementsBySlug,
    setOutlineOverlay,
    setReducedMotionPreview,
    getThemeTokens,
    getLiveClientState,
    fetchBackendDiagnostics,
    inspectCurrentPage,
  };
}

export function installUiDebugApi(): GitGraveyardUiDebugApi | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }

  const api = window.__GIT_GRAVEYARD_UI_DEBUG__ ?? createUiDebugApi();
  window.__GIT_GRAVEYARD_UI_DEBUG__ = api;

  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("uiDebug") === "1") {
      api.setOutlineOverlay(true);
    }
  } catch {
    // Ignore malformed query strings
  }

  return api;
}
