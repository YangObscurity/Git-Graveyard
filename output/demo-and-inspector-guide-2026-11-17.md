# Git-Graveyard Demo, Replay & Live-State Inspector Guide

Date: 2026-11-17
Branch context: `main`

This guide documents the live-state inspection endpoints, CLI/UI debugging tools, offline Playwright E2E suite (`T35`), and recorded-run replay path (`T40` -> `T41` / `T7`).

---

## 1. Backend Actual-State Inspection Endpoints

All inspection routes return `Cache-Control: no-cache` JSON derived from the live `RunStore`, `EventStore`, `RuntimeHost` / `Admission`, `probe-gate`, `reduceRunView(...)`, and recorded-runs directory on disk.

### `GET /api/health` and `GET /api/health?detail=1`
- **Public health**: returns `{ status, liveRunStatus, reason, queueLength, badgeText, ok, engineVersion }`.
- **Detailed mode (`?detail=1`)**: attaches `diagnostics` containing `{ stores, runtimeHost, orchestrator, probes }` from `collectSystemDiagnostics({ probeToolchains: false })`.
- Note: `GET /api/health` triggers `getRuntimeHost()` on cold boot when no runtime global is injected yet.

### `GET /api/debug/status`
- **Query flags**:
  - `?probeToolchains=1` — runs local toolchain probes (`git`, `node`, `npm`, `docker`, `kiro-cli`, `gh`) in addition to store/runtime/orchestrator state.
  - `?uiDebug=1` (or request header `x-ui-debug: 1`, or verified `ADMIN_TOKEN` via `x-admin-token` / `Authorization: Bearer <ADMIN_TOKEN>`) — satisfies `authorizeDebugRequest(...)` in production builds (`NODE_ENV=production`).
- **Response**: `{ ok: true, diagnostics }` covering `health`, `stores` (`runStore`, `eventStore`, `recordedRuns`), `admission`, `runtimeHost`, `orchestrator`, `probes` (`probeGate`, `toolchains`, `env`, `disk`), and `recentRuns`.

### `GET /api/debug/runs/[runId]`
- **Access guard**: same `authorizeDebugRequest(...)` guard (`?uiDebug=1`, `x-ui-debug: 1`, or verified `ADMIN_TOKEN`; always open in non-production unless overridden).
- **Response**: deep consistency snapshot for `<runId>`:
  - `run`: raw `RunRecord` metadata (with secret hashes omitted/redacted).
  - `sequenceIntegrity`: `totalEvents`, `firstSeq`, `lastSeq`, and `gaps` check.
  - `countsByKind` & `countsByActor`: event histogram across kinds/actors.
  - `phaseParity`: comparison of stored `RunRecord.phase` vs `reduceRunView(events).phase`.
  - `reducedView`: live reducer state (`phase`, `outcome`, `pactStatus`, `pactVersion`, `skeletons`, `pendingApprovals`, `openAsks`, `tasks`, `beforeAfterRows`, `reportReady`).
  - `activeHandle`: live orchestrator handle info if running in-process.
  - `artifacts`: per-artifact disk verification (`all.patch`, `spec.json`, `report.md`, `events.ndjson`, `death-certificate.json`) comparing `eventRecordedSha256` vs actual disk SHA-256 (`shaMatch`, `presentOnDisk`, byte size).
  - `latestEvents`: tail of recent events for immediate triage.

### `POST /api/debug/sim` (Development / Explicit Opt-In Only)
- **Safety gate (`authorizeSimRequest`)**: disabled (`403`) in `NODE_ENV=production` unless `ALLOW_DEBUG_SIM=1` AND a verified `ADMIN_TOKEN` is supplied via `x-admin-token` or `Authorization: Bearer <ADMIN_TOKEN>`.
- **Supported `action` values**:
  - `create_invite`: mints a local test invite code stored in `RunStore` (returns `{ code, ... }`).
  - `seed_recorded_runs`: explicitly seeds recorded runs from `output/recorded-runs/` into the active stores.
  - `step_run`: advances or injects deterministic lifecycle events for a `runId` (`step`: `exhume` | `certificate` | `plan` | `pact` | `legion` | `approval` | `ask` | `done_resurrected` | `done_partial` | `publish`).

---

## 2. CLI Inspector (`npm run status`)

Run locally without booting a browser:

```bash
npm run status
```

Supported flags from `scripts/dev-status.ts`:
- `--url <baseUrl>` (e.g. `--url http://127.0.0.1:3000`): prints local store/disk diagnostics AND probes `/api/health?detail=1`, `/api/debug/status`, and optional `/api/debug/runs/[runId]` over HTTP with latency timings.
- `--run <runId>`: includes deep `inspectRunDiagnostics(runId)` output (event sequence parity, reducer parity, artifact SHA-256 verification).
- `--admin-token <token>`: forwards `x-admin-token` when probing a protected server.
- `--no-toolchains`: skips spawning CLI `--version` subprocess probes for faster checks.
- `--json`: outputs machine-readable JSON.

---

## 3. UI Debug Surface & Live HUD

### Debug Workbench (`/debug/ui?uiDebug=1`)
- **Synthetic Fixture Matrix (`?uiDebug=1` / `mode=fixtures`)**:
  - Preset switcher across lifecycle states (`loading`, `reconnecting`, `exhume`, `certificate`, `pact`, `legion`, `approval`, `ask`, `resurrected`, `partial`, etc.) plus automated cycle toggle (`Live Fixture Cycle`) and theme-token/element outline inspection.
- **Live Runtime Inspector (`?uiDebug=1&mode=live`, tab `Live Runtime Inspector`)**:
  - Queries `GET /api/health?detail=1`, `GET /api/debug/status?uiDebug=1&probeToolchains=1`, and `GET /api/debug/runs/[runId]?uiDebug=1`.
  - Displays live store metrics (`RunStore`, `EventStore`), Probe Gate status, Toolchain presence, recent runs list (clickable for per-run reducer parity + artifact SHA-256 checksums), API Probe quick buttons, and the Dev Sandbox Driver Panel when `/api/debug/sim` is permitted.

### Live HUD Overlay on Any Page (`?uiDebug=1`)
Append `?uiDebug=1` to any route (for example `/?uiDebug=1`, `/history?uiDebug=1`, `/runs/<runId>/legion?uiDebug=1`):
- Activates CSS element outlines (`data-ui-debug-outline="true"`).
- Renders the floating `UiDebugLiveHud` (`data-testid="ui-debug-live-hud"`) via `UiDebugBootstrap`, showing current `LiveClientState` (subscribed SSE run snapshots, `lastSeq`, `phase`, `pactStatus`) alongside live backend health and run inspection snapshots.

### Browser Console Helper (`window.__GIT_GRAVEYARD_UI_DEBUG__`)
Exposed automatically by `UiDebugBootstrap` in browser pages (`lib/ui-debug.ts`):
- `inspectCurrentPage(opts?)` — asynchronously returns `{ client, domElements, themeTokens, backend }` combining DOM `[data-ui-element]` bounding boxes/visibility, computed CSS theme tokens, active client SSE reducer state, and `/api/debug/status` + `/api/debug/runs/[runId]`.
- `listElements()` / `getElementsBySlug(slug)` — returns DOM element metadata (`element`, `state`, `variant`, `testId`, `rect`, `visible`).
- `getLiveClientState()` — synchronous snapshot of subscribed client stores.
- `fetchBackendDiagnostics(opts?)` — fetches `/api/debug/status` and optional `/api/debug/runs/[runId]`.
- `setOutlineOverlay(boolean)` / `setReducedMotionPreview(boolean)` / `getThemeTokens()`.

---

## 4. Playwright E2E Suite (`T35`)

Specs live in `e2e/` (isolated from `test/` so `tsx --test` unit/golden suites never collide with Playwright):
- `e2e/gate-and-history.spec.ts` — Gate form validation, HealthBadge status, mandatory attribution footer, `/history` recorded-run badge, zero-credential `/replay/live-gulp-plumber-t40` SSE-ordered playback, and `/runs/live-gulp-plumber-t40/relic` outcome/diff/ledger/artifact checksums.
- `e2e/full-resurrection-journey.spec.ts` — Mints local invite code via `/api/debug/sim`, runs full Gate -> `/tomb/...` -> Pact locking & approval -> `/runs/<id>/legion` live approvals/asks + pause/resume + inline 401/403 invite unlock -> final Reliquary & History listing.
- `e2e/debug-live-inspector.spec.ts` — Verifies `/debug/ui?uiDebug=1` fixture presets, `Live Runtime Inspector` tab + per-run `phaseParity` & artifact SHA-256 verification, `/?uiDebug=1` floating HUD, and `window.__GIT_GRAVEYARD_UI_DEBUG__.inspectCurrentPage()`.

`e2e/start-e2e-server.mjs` boots Next against ephemeral temporary `RUN_STORE_PATH`, `EVENT_STORE_PATH`, and `RUNS_DIR` directories with `KIRO_*` and `GITHUB_*` tokens stripped from the environment, proving full offline/zero-credential reproducibility.

Run locally:

```bash
npm run test:e2e
```

---

## 5. Offline Demo Replay Path (`T40` -> `T41` / `T7`)

No Kiro API key, GitHub token, or remote sandbox container is required to replay the recorded `T40` resurrection run (`floatdrop/gulp-plumber`):

1. Confirm recorded bundle exists under `output/recorded-runs/live-gulp-plumber-t40/` (`run.json`, `events.ndjson`, and `artifacts/{all.patch,spec.json,report.md,events.ndjson,death-certificate.json}`).
2. Start the local Next server (`npm run dev`, or `npm run build && npm run start`).
3. Visit `/history` — `floatdrop/gulp-plumber` appears with the `Recorded run` badge (`runId: live-gulp-plumber-t40`).
4. Open `/replay/live-gulp-plumber-t40` to step through the recorded 66-event timeline in `seq` order under the persistent `Replay` banner (no mutating run controls rendered).
5. Open `/runs/live-gulp-plumber-t40/relic` to inspect the final Reliquary (`Resurrected` verdict, Before/After table, unified `all.patch`, `TaskLedger`, and SHA-256 verified artifact downloads).
