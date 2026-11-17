# Git-Graveyard

> Kiroween 2026, Resurrection track entry.

Git-Graveyard diagnoses why an abandoned GitHub repository died and brings it back. A rule engine (the Grimoire) gives an instant diagnosis with receipts. With an invite code, a live run installs, builds and tests the repository in a sandbox, plans the fix as a Kiro spec, and has Kiro CLI sessions carry out the approved tasks under review. Skeleton sessions run on Kiro CLI. Git-Graveyard is an independent project.

## Status

Core engine & Cryptic Gothic Terminal UI are complete on `main`: Necromancer backend orchestration, Grimoire M1–M6 rules/gate, Warden verification, Next.js 16 UI, `/debug/ui?uiDebug=1` showcase & live-state inspector, live-state diagnostic APIs (`/api/health?detail=1`, `/api/debug/status`, `/api/debug/runs/[runId]`, `/api/debug/sim`), Playwright E2E suite (`T35`), code neatness & pre-public privacy cleanup (`T37`/`T38`), and a real sandboxed Kiro CLI recorded resurrection (`live-gulp-plumber-t40` for `T40`). See [`output/demo-and-inspector-guide-2026-11-17.md`](output/demo-and-inspector-guide-2026-11-17.md) for demo replay and live-state inspection instructions; only final demo video recording and submission visibility switch remain.

## Workspace

| Layer | Where |
|---|---|
| Isolation | Sub-agent work goes to `.agent-ws/<task-id>/` and is never committed |
| Promotion | Only `output/`, `01_evidence/`, `Temp/` and `memory/` content is kept |
| Mechanical block | `.git/hooks/pre-commit` rejects `.agent-ws/`, `*.tmp` and `~$*` |
| Memory | `memory/` (PROJECT, TASKS, RUNS) |
| Rules | Global in `~/.kiro/steering/`, project in `.kiro/steering/` |

## Layout

```
Git-Graveyard/
|-- AGENTS.md              # agent working rules
|-- PLAN.md                # short overview
|-- REFERENCES.md          # contest rules and references
|-- LICENSE                # MIT
|-- .kiro/steering/        # product, tech, structure, modernization-rules
|-- .kiro/specs/           # resurrection-engine spec
|-- memory/                # project memory
|-- output/                # deliverables
|-- 01_evidence/           # evidence (append-only)
|-- Temp/                  # reusable scripts
`-- .agent-ws/             # sub-agent scratch area (created on demand)
```

## Self-hosting

A live run needs:

- a Kiro API key from a paid Kiro plan, held only by the Necromancer service;
- a sandbox host: Docker on the development machine, or Docker Agentic Platform cloud sandboxes in production;
- a GitHub token (unauthenticated GitHub allows 60 requests per hour).

The autopsy, History and Replay work without Kiro. Never commit host addresses, keys or tokens.

## Development

Requires **Node.js 24+ / 26+** (for built-in `node:sqlite`). Autopsy, History/Replay (`live-gulp-plumber-t40`), `/debug/ui?uiDebug=1`, and unit/API/E2E tests run without Docker or Kiro credentials:

```powershell
npm install
npm run dev          # http://localhost:3000 (open /debug/ui?uiDebug=1 for offline UI lab & live inspector)
npm run typecheck    # tsc --noEmit
npm run status       # CLI live-state diagnostics (store, recorded runs, SHA-256 parity)
npm run build
npm run test:e2e     # Playwright offline E2E suite (Gate -> Pact -> Legion -> Reliquary -> Replay)
.\node_modules\.bin\tsx --test test\api\*.test.ts test\app\*.test.ts test\app\*.test.tsx test\ui\*.test.ts
$env:GITHUB_TOKEN = "<token>"   # raises the GitHub rate limit
```

## Contest checklist

- [ ] Public GitHub repository (private for now; pre-public privacy & history cleanup complete, switch to public before submission)
- [x] `.kiro/` at the repository root (steering and specs)
- [x] Open-source license (MIT)
- [ ] 2 to 3 minute demo video
- [x] Working application (real sandboxed run `live-gulp-plumber-t40` + offline Replay & Playwright E2E verified)

## Documents

- `output/demo-and-inspector-guide-2026-11-17.md`: live-state inspector endpoints, Playwright E2E, and offline recorded-run demo replay guide
- `output/project-handoff-2026-11-16.md`: earlier milestone handoff baseline (superseded on `main` by the guide above)
- `PLAN.md`: short overview
- `.kiro/specs/resurrection-engine/`: requirements, design and task plan
- `REFERENCES.md`: contest rules, past winners, Kiro mechanics
- `AGENTS.md`: boundaries, acceptance, memory protocol
- `memory/`: local project memory and run log (gitignored)
