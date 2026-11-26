---
inclusion: always
---

# Product - Git-Graveyard

## What it is

Git-Graveyard brings abandoned GitHub repositories back to life. The Grimoire, a rule engine that uses no model, diagnoses why a repository died. With an invite code, the Necromancer service then runs the repository for real: it installs, builds and tests it in a sandbox, has the Planner write a Pact (requirements, design and tasks for that repository), and after the user approves the Pact raises Skeleton workers to carry out the tasks. Each Skeleton is a separate Kiro CLI session. The output is a patch, the spec bundle and a report, with an optional push to a fork owned by the owner.

Authoritative design: `.kiro/specs/resurrection-engine/design.md` (Revision 4 wins over earlier revisions).

## Users

- Hackathon judges (Kiroween 2026, Resurrection track)
- Developers who want to reuse an old project but are blocked by deprecated dependencies

## Core journey

1. Gate (`/`): paste a repository URL; see the live-run status and recent recorded runs.
2. Tombstone (`/tomb/[owner]/[repo]`): the instant autopsy (lifespan, stars, Last Words, Signal_Chips with receipts); with an invite code, the live Exhume and the Death Certificate (baseline install, build and test results).
3. Pact (`/runs/[runId]/pact`): read, edit and approve the plan before any builder starts.
4. Legion (`/runs/[runId]/legion`): watch and steer every Skeleton; answer approvals and asks.
5. Reliquary (`/runs/[runId]/relic`): outcome, before and after table, diff, task ledger and downloads.
6. History and Replay: real recorded runs only, published after admin review and redaction.

## Copy rules

- The allowed Kiro statement is "Skeleton sessions run on Kiro CLI." The Gate footer adds "Git-Graveyard is an independent project."
- Every number comes from a recorded source; otherwise show `not available` or `not reported`. No scores and no estimates.
- Never claim "X% faster", "hours saved", "production ready", "safe", that a Skeleton "understood" something, or that the app is a Kiro product.
- User-facing text is English. The gothic voice is for headings and empty states; error messages use plain words and say what to do next.

## Out of scope

- No push, pull request, issue or comment against the original repository. A push goes only to a fork owned by the owner, on a new branch `graveyard/<runId>`, and only when the invite code allows it.
- No general code generator. The scope is dependency and syntax modernization that makes the repository install, build and pass its tests again.
- No CVE or vulnerability claims in v1.
