---
inclusion: always
---

# Tech - stack and constraints

Authoritative source: `.kiro/specs/resurrection-engine/design.md` (Revision 4 wins over earlier revisions).

| Layer | Choice | Constraint |
|---|---|---|
| UI | Next.js 16 App Router, React 19, TypeScript, Tailwind CSS | Runs on the host next to the Necromancer; no Vercel |
| Necromancer | Node/TypeScript service on the host | Owns planning, scheduling and every policy decision; the only holder of the Kiro key, GitHub tokens and admin secret |
| Skeletons | `kiro-cli` 3.1.0, one `kiro-cli acp --agent-engine=v3` process per Skeleton | Built-in shell denied; commands go through the gateway tool `sandbox_exec`; permission answers are one-time only. Headless `stream-json` is a fallback used only if probe P1 fails |
| Models | Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 only | Model pinned per role and verified at session start |
| Event store | SQLite, append-only, served over SSE with `Last-Event-ID` resume | Runs continue when the browser closes |
| Execution | `ExecutionBackend`: `instabox-docker` (development) or `docker-cloud-sandbox` (production, topology P-B) | Repository code runs only inside a per-run container; no Kiro key, GitHub credential or Docker socket inside |
| Grimoire | Rules M1 to M6; `@babel/parser` for JS and TS, `web-tree-sitter` for Python | No model call and no repository code during the autopsy; also the pre-merge gate |
| Diff | Monaco served locally, plain `<pre>` fallback | Works with no network |
| Tests | fast-check properties, golden tests, Playwright with axe-core; CPython oracle (`ast.parse` with `feature_version=(3, 13)`) in CI only | |
| Data | GitHub REST API | Unauthenticated limit is 60 requests per hour; use `GITHUB_TOKEN` |

## Merge rule

A task merges only after the Grimoire gate passes and the Warden returns `approve` with a matching `candidateSha256`. A rejected task is re-dispatched, re-planned, skipped or stopped; nothing merges over the Warden.

## Environments

- Development: the development sandbox host runs the Necromancer, UI, event store and per-run Docker containers, with one live run at a time. Its SSH address never enters the repository.
- Production: an always-on host plus Docker Agentic Platform cloud sandboxes, created only after the promotion gate audit (design E5) passes.
