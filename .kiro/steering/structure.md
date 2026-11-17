---
inclusion: always
---

# Structure - folders and naming

| Path | Role |
|---|---|
| `app/` | Next.js pages and API routes |
| `components/` | UI components (Tombstone, Pact editor, Skeleton cards, Reliquary views) |
| `lib/` | Necromancer services: supervisor and ACP client, gateway, scheduler, Warden, Git, execution backends, event store, admission and budgets |
| `lib/rules/` | Grimoire rules M1 to M6 |
| `lib/agents/templates/` | Committed role agent templates, copied into each Skeleton's `$KIRO_HOME/agents/` |
| `lib/gateway/command-policy.json` | Committed command policy for `sandbox_exec`; only a commit changes it |
| `scripts/` | Phase 0 probes, fixture pinning and baking, evidence builder, audit scripts |
| `test/` | Property, golden, end-to-end and audit tests; `test/golden/` holds committed expected output |
| `.kiro/steering/` | Always-on rules (this folder) |
| `.kiro/specs/resurrection-engine/` | Engine spec: requirements, design, tasks |
| `.kiro/specs/resurrection/<owner>-<repo>/` | Grimoire bundles written by `npm run bake:presets` for the test fixtures; scripts write here, agents do not |
| `.kiro/hooks/` | Build-time hooks (Requirement 48) |
| `memory/` | Project memory |
| `output/`, `01_evidence/`, `Temp/` | Deliverables, evidence (append-only), reusable scripts |

## Routes

- Top-level actions use `app/api/<verb-noun>/route.ts`: `/api/run-autopsy`, `/api/start-run`.
- Resources nest under a noun with dynamic segments:
  - Implemented in Increment 1: `/api/runs/[runId]`, `/api/runs/[runId]/events`, `/api/runs/[runId]/pact`, `/api/runs/[runId]/approvals`, `/api/runs/[runId]/asks`, `/api/runs/[runId]/skeletons/[skeletonId]`, `/api/runs/[runId]/control`, `/runs/[runId]/relic/download`, `/api/history`, `/api/health`, `/api/debug/status`, `/api/debug/runs/[runId]`, `/api/debug/sim`.
  - Deferred to Increment 3+ (per scope stop at Increment 1): `/api/runs/[runId]/messages`, `/api/runs/[runId]/artifacts`, `/api/runs/[runId]/push-fork`, `/api/admin/...`.
- Pages:
  - Implemented in Increment 1: `/`, `/tomb/[owner]/[repo]`, `/runs/[runId]`, `/runs/[runId]/pact`, `/runs/[runId]/legion`, `/runs/[runId]/relic`, `/history`, `/replay`, `/replay/[runId]`, `/debug/ui`.
  - Deferred to Increment 3+: `/built-with-kiro`, `/admin`.

## Naming

Components use PascalCase; files and functions follow Next.js conventions.
