# Implementation Plan: resurrection-engine

## Overview

Implementation plan for the resurrection engine (design Revision 4). It follows the R4-21 increments: Increment 0 runs the Phase 0 probes; Increment 1 builds a vertical slice for one Node repository on the development box; Increment 2 calibrates the E11 defaults from the first three recorded runs; Increment 3 completes v1 (Python, Bonesetter, parallel Soul-stitchers, messaging, admission and budgets, the Scribe, remaining UI); Increment 4 adds the production backend behind the promotion gate. Each increment ends with a checkpoint that gates the next one. Tasks marked with * are optional tests.

## Execution Ownership (Updated 2026-11-26)

- **Completed Baseline (Increment 0 & Increment 1 — Tasks 1 to 16 + PR #1/#2/#3 follow-ups)**: All marked `[x]` below (including macOS auth, model override, single-write EventStore, and `hasBuild: false` reporting).
- **Waves 1–6 (Increment 2 code + Increment 3 code + Increment 4 pure validation/schema code & offline tests, executed via 3 Instabox workers)**:
  - **Wave 1 (`WP-17`, `WP-19A`, `WP-20A`)**: `SettingsStore` & `scripts/calibrate-e11.ts` (Tasks `17.1`–`17.3`), Python M1 rules & `python-gate.ts` (Tasks `19.1`–`19.2`), `bonesetter.ts`, `stream-parser.ts`, & `headless-fallback.ts` (Tasks `20.1`–`20.2`).
  - **Wave 2 (`WP-19B`, `WP-20B`, `WP-21A`)**: CPython 3.13 oracle, deterministic bundle generator, `bake.ts` + MIT `F-python2` fixture, and property tests P2/P4/P5/P7/P8/P9 (Tasks `19.3`–`19.10`), `parallel-scheduler.ts` & tests (Tasks `20.3`–`20.4`), `MessageService`, `AskManager`, `hard-blocks.ts`, fork-only `pushToFork`, and P15 test (Tasks `21.1`–`21.3`, `21.5`).
  - **Wave 3 (`WP-21B`, `WP-22`, `WP-23`)**: Run mutation APIs & `lib/ui/api.ts` (Task `21.4` + R4-10, backward-compatible), Admission/Invite/Queue, `BudgetGovernor` P20, `AdminSession` HMAC cookie & `KillSwitch`, `/api/admin/*` (Tasks `22.1`–`22.5`), `ScribeService`, `ReportCheck`, `failure-recovery.ts`, `boot-reconciliation.ts` (Tasks `23.1`–`23.5`).
  - **Wave 4 (`WP-25A`, `WP-24A`, `WP-26`)**: M1–M31 metrics & P14 + `GlossedTerm` + `claims-linter` (Tasks `25.1`–`25.3`), remaining UI states on Gate/Tombstone/Exhume/Pact (Tasks `24.4`–`24.7`), `build-evidence.ts` → `public/kiro-evidence.json`, `BuiltWithKiroEvidence`, & `OpenInKiroHandoff` (Tasks `26.1`–`26.4`).
  - **Wave 5 (`WP-24B`, `WP-24C`, `WP-28A`)**: Legion remaining UI states, `LayToRestModal`, `TaskGraph`/`TaskTable`, `run-model.ts` (Tasks `24.1`–`24.3`), Reliquary/History/Replay remaining states, `/built-with-kiro`, `/admin`, `KillSwitchModal`, `CryptNav` (Tasks `24.8`–`24.10`), `lib/execution/*` Topology P-B cloud sandbox backend & tests (Tasks `28.1`–`28.4`).
  - **Wave 6 (`WP-25B`, `WP-29`)**: A11y components, global CSS focus/contrast/reduced-motion, 9-page `@axe-core/playwright` E2E (`e2e/accessibility.spec.ts`) (Tasks `25.4`–`25.6`, Checkpoint 27); offline Promotion Gate schema/engine, audit scripts (`lib/audit/*`, `scripts/audit/*`), `/api/admin/promotion-audit` wiring, & offline unit tests (`test/audit/promotion-gate.test.ts`) for Tasks `29.1`–`29.4` (pure code & offline tests only; no live audit sign-off or credential rotation here).
- **Wave 7 (Owner Live Verification on `instabox_dev` with `kiro-cli` Claude 5.5 + Docker Sandbox)**:
  - **Task 18 Checkpoint**: Record 2 additional live sandbox runs on `instabox_dev` into `output/recorded-runs/` (reaching 3 recorded runs total) and run `scripts/calibrate-e11.ts`.
  - **Task 20 / Task 23 Live Verification**: Live multi-Skeleton (`Soul-stitcher`) concurrency and real container OOM/TTL recovery verification on `instabox_dev`.
  - **Pre-Production Audit & Credential Rotation (Tasks `29.2`–`29.4` live execution & `T23`)**: Run live G1/G3 Security Access Audits, execute `XR-01..XR-03` sandbox checks, sign off audit evidence in `01_evidence/`, and rotate development credentials (`CLINE_API_KEY` / dev tokens) prior to Task 30.
- **Excluded / Post-Hackathon**: Increment 5 Stretch (`F25`–`F27`) is explicitly excluded by Owner decision; Task 30 live production cloud sandbox deployment awaits production cloud sandbox credentials.

## Tasks

- [x] 1. Phase 0 probe harness
  - [x] 1.1 Write dev box preparation script
    - Create scripts/phase0/prep-devbox.sh to inspect system architecture using uname -m and C library version using ldd --version
    - Verify sha256 checksum and install kiro-cli 3.1.0 from the manifest artifact
    - Write root-owned KIRO_DEFAULT_SETTINGS file configuring telemetry off and auto-update off
    - Verify that only the development Kiro key is loaded into the execution environment before probe execution
    - _Requirements: 45.5_
  - [x] 1.2 Write Phase 0 probe runner and evidence capture harness
    - Create scripts/phase0/runner.ts to execute probes P1 through P17 and spikes S1 through S5 in the design-specified sequence
    - Capture full stdout and stderr transcripts for each probe into 01_evidence/phase0-<date>/<id>/
    - Format and append each probe result as a single line to memory/RUNS.md
    - Include operator checks requiring an active session during recordings (P13) and manual wake verification before use (S5)
    - _Requirements: 45.4, 45.13, 45.14_
  - [x] 1.3 Write probe results parser and live run gate
    - Create lib/probes/runs-parser.ts to read memory/RUNS.md and treat any missing probe or spike as not passed
    - Create lib/probes/gate.ts to keep development live runs disabled while any of probes P1 to P9, P12 to P15, or spikes S1 to S5 lack recorded passing results (a real exit-code-1 failure of P2, P4, P5, or P9 with its fallback implemented is reported as settledByFallback and does not block)
    - Enforce in lib/probes/gate.ts that production live runs remain disabled while any of probes P10, P11, P16, or P17 lack recorded passing results
    - _Requirements: 45.1, 45.2, 45.3_
  - [x] 1.4 Write probe decision evaluator and runtime fallback configuration resolver
    - Implement lib/probes/probe-settles.ts resolving Skeleton HOME isolation fallback from probe P4 result, assigning each Skeleton an isolated HOME directory resolving ~/.kiro/agents/ per Skeleton if /agents is ignored
    - Resolve documented-safe permission form from probe P6 result, allowing explicit paths, routing other actions to ask, and rejecting in PermissionBroker
    - Resolve single-Skeleton concurrency limit from probe P8 or spike S4 result when parallel sessions exceed host capacity
    - Resolve internal sandbox disabling and stdio shim spawning with explicit sanitized environment from probe P9 result if bwrap is unavailable
    - _Requirements: 45.6, 45.7, 45.8, 45.9_
  - [x] 1.5 Write security and channel fallback configuration resolver
    - Implement lib/probes/probe-fallbacks.ts enforcing mandatory symlink scan before every prompt and after every sandbox_exec when probe P12 indicates file tools follow symlinks
    - Direct Owner to Kiro portal for credit balance if probe P15 shows _kiro/account/getUsage is not advertised, and verify connection via gateway records if no MCP status method is advertised
    - Activate Headless_Fallback channel if probe P1 fails to operate headlessly with KIRO_API_KEY, but keep Headless_Fallback disabled for live runs if probe P14 shows stream-json cannot verify active model
    - Enforce caps on wall-clock time and tool calls only with UI displaying not reported if probe P5 shows turn_completion lacks credits, and remove loaded repo Kiro files and mark skip-worktree if probe P7 shows ACP loading
    - _Requirements: 45.10, 45.11, 45.12, 45.15, 45.16, 45.17, 45.18_
  - [x] 1.6 Write unit tests for Phase 0 harness, parser, and fallback resolvers
    - Write test/probes/harness.test.ts asserting probe runner execution, transcript capture, and single-line appending to memory/RUNS.md
    - Test lib/probes/runs-parser.ts and lib/probes/gate.ts gating development and production live runs against missing probe outcomes
    - Test fallback state resolution across lib/probes/probe-settles.ts and lib/probes/probe-fallbacks.ts under passing and failing probe records
    - _Requirements: 45.1, 45.2, 45.3, 45.4, 45.5, 45.6, 45.7, 45.8, 45.9, 45.10, 45.11, 45.12, 45.13, 45.14, 45.15, 45.16, 45.17, 45.18_

- [x] 2. Checkpoint - Phase 0 results recorded. Run npx tsx scripts/phase0/runner.ts --verify and npm test test/probes/harness.test.ts, ask the user if questions arise.

- [x] 3. Project scaffold, test tooling and build-time Kiro hooks
  - [x] 3.1 Initialize Next.js 16 project scaffold, TypeScript configuration, and package scripts
    - Configure package.json with Next.js 16 App Router, React 19, TypeScript strict mode, and Tailwind CSS styling
    - Define package.json scripts for dev, build, test:signals, test:props, test:golden, test:e2e, test:oracle, pin:fixtures, bake:presets, and evidence:build
    - Configure dependencies including @babel/parser, web-tree-sitter@0.27.1, tree-sitter-python@0.25.0, diff, zod, fast-check, and @monaco-editor/react
    - Update .gitignore to ignore .cache/ while ensuring no files under .kiro/ are ignored
    - _Requirements: 47.1_
  - [x] 3.2 Implement prebuild asset pipeline and wasm verification scripts
    - Create scripts/copy-monaco.mjs to copy Monaco Editor assets from node_modules/monaco-editor/min/vs to public/monaco/vs for offline diffing
    - Create scripts/generate-engine-version.mjs to generate engineVersion by hashing lib/rules/ and lib/engine/ sources
    - Create scripts/check-wasm.mjs to verify that web-tree-sitter initializes and loads the tree-sitter-python wasm module correctly
    - Wire copy-monaco.mjs, generate-engine-version.mjs, and check-wasm.mjs into package.json predev and prebuild scripts
    - _Requirements: 47.1_
  - [x] 3.3 Create plain-English glossary and UI copy dictionary
    - Implement lib/copy/glossary.ts defining plain-English glosses for all gothic terms: Necromancer, Skeleton, Grimoire, Pact, Death_Certificate, Legion, Reliquary, and Lay_to_rest
    - Define the canonical Kiro CLI role description requiring the exact wording "Skeleton sessions run on Kiro CLI."
    - Provide plain-words formatting helpers for error messages that state clear next actions, and gate footer text stating "Git-Graveyard is an independent project."
    - Enforce that the gothic voice is restricted to headings and empty states across all UI copy dictionaries
    - _Requirements: 47.1, 47.2, 47.3, 47.4, 47.5, 47.6_
  - [x] 3.4 Configure build-time Kiro project hooks
    - Create .kiro/hooks/build-hooks.json conforming to the v1 schema with version "v1" and hooks array
    - Register rules-props hook with trigger PostFileSave and matcher lib/rules/.*\.ts$ executing npm run test:props
    - Register task-golden hook with trigger PostTaskExec executing npm run test:golden
    - Configure hook execution error handling so non-zero exits deliver stderr to the agent without blocking actions
    - _Requirements: 48.1, 48.2, 48.3, 48.14_
  - [x] 3.5 Implement PreToolUse hook path guard script for protected directories
    - Create scripts/hooks/guard-paths.mjs to read tool invocation payloads from stdin on PreToolUse trigger
    - Block agent write tools targeting test/golden/, .kiro/specs/resurrection/, 01_evidence/fixtures/, or .cache/ with exit code 2
    - Allow agent write tools targeting .agent-ws/ or script-baked output directories without blocking
    - Wire guard-paths.mjs into .kiro/hooks/build-hooks.json under PreToolUse trigger
    - _Requirements: 48.4, 48.13_
  - [x] 3.6 Write unit tests for project hooks, path guards, and glossary
    - Write test/hooks/kiro-hooks.test.ts asserting .kiro/hooks/build-hooks.json schema validity and hook configurations
    - Test scripts/hooks/guard-paths.mjs blocking protected target paths with exit code 2 while permitting allowed output directories
    - Test hook failure delivery ensuring stderr is reported without blocking agent execution
    - Test lib/copy/glossary.ts term definitions, Kiro role description phrasing, and plain-words error message formatting
    - _Requirements: 47.4, 47.5, 48.1, 48.2, 48.3, 48.4, 48.13, 48.14_

- [x] 4. Grimoire core for Node: input normalization, fetch, detection, dead or alive, Last Words and receipts
  - [x] 4.1 Implement repository input normalization and URL validation
    - Implement parseRepoInput in lib/grimoire/normalize.ts reducing HTTPS and SSH GitHub URLs to (owner, repo) regardless of trailing slashes, .git suffixes, queries, fragments, or /blob/... paths
    - Detect /tree/<ref> path segments, recording that the default-branch head commit is analysed instead of the ref and setting a notice flag
    - Reject inputs with error code BAD_URL if host is not github.com, if userinfo or port is present, or if owner or repo contains characters outside [A-Za-z0-9_.-] or equals . or ..
    - Restrict outbound request URL construction strictly to api.github.com, codeload.github.com, and registry.npmjs.org using validated owner, repo, and sha
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_
  - [x] 4.2 Implement GitHub metadata and commit fetcher with rate limit handling
    - Implement fetchRepoMetadata in lib/grimoire/github.ts querying GET /repos/{owner}/{repo} to read full_name, default_branch, created_at, archived, stargazers_count, and forks_count
    - Query GET /repos/{owner}/{repo}/commits/{default_branch} to read default-branch head sha, commit message, and set lastCommitAt to committer date
    - Handle error conditions: return REPO_EMPTY when default branch has no commit, REPO_NOT_FOUND when repo is missing or private, and RATE_LIMITED with reset time when rate limit is exhausted
    - Implement retry logic failing with GITHUB_UNAVAILABLE after two consecutive network errors or 5xx responses, preserving full_name for display
    - _Requirements: 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_
  - [x] 4.3 Implement streaming repository archive extractor and security gate
    - Implement extractArchive in lib/grimoire/archive.ts to stream tarball from codeload.github.com, enforcing limits of 20 MB compressed, 60 MB decompressed, and 2000 entries, failing with TOO_LARGE
    - Reject archive entries with absolute paths, parent directory traversal (..), symlinks, or hard links with ARCHIVE_UNSAFE
    - Treat Git LFS pointer files as non-scanned binary files, skip submodule directory entries, and mark non-UTF-8 text files as encoding_unsupported
    - Enforce a 20-second request watchdog failing with TIMEOUT, completing the autopsy without running repository code and without model calls
    - _Requirements: 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 2.15_
  - [x] 4.4 Implement file inventory, language classification, and Manifest Directory ordering
    - Implement scanInventory in lib/grimoire/detect.ts filtering files by approved extensions and manifests up to 400 files in sorted path order
    - Inventory lock files (package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml, poetry.lock, Pipfile.lock) for existence only
    - Classify languages: include node when package.json exists and python when Python files or manifests exist, failing with LANGUAGE_UNKNOWN if empty
    - Assign source files to nearest ancestor Manifest_Directory (or root for Python without ancestor), order Node directories first then Python directories by path, and cap at 10 directories
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_
  - [x] 4.5 Implement AST legacy pattern detector and Signal generator
    - Implement detectSignals in lib/grimoire/signals.ts using @babel/parser for JS and TS files, recording parse_error on unparseable files and continuing
    - Suppress Signal emission for patterns occurring inside comments or string literals
    - Construct Signal records containing rule ID, file:line:column, matched pattern, confidence (high, medium, low), and associated Manifest_Directory
    - Sort output Signals deterministically by (file, line, column, ruleId)
    - _Requirements: 3.10, 3.11, 3.12, 3.13_
  - [x] 4.6 Implement dead-or-alive verdict calculator and lifespan metrics
    - Implement computeVerdict in lib/grimoire/verdict.ts evaluating archived flag, dormant (lastCommitAt older than asOf minus 24 calendar months), and deprecation_signal (high-confidence M1-M4 Signals, excluding M5-M6)
    - Set status dead if at least one reason is present, otherwise status alive with label "still breathing" while keeping full autopsy visible
    - Compute lifespanYears as (lastCommitAt - createdAt) in fractional years with one decimal place (reporting unknown if negative) and yearsDead as (asOf - lastCommitAt)
    - Support asOf timestamp set to autopsy request time for live runs or pinned fixture date for committed offline fixtures
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11_
  - [x] 4.7 Implement Last Words extractor, receipt formatter, and autopsy coordinator
    - Implement formatAutopsy in lib/grimoire/autopsy.ts extracting Last_Words from the first non-empty line of the default-branch head commit message up to 120 UTF-8 characters, with plain text escaping helper
    - Generate templated autopsy cause text without model calls, including the mandatory disclaimer "Grimoire's instant verdict is rule-based and has not run your code."
    - Group Signal_Chips by rule ID M1 to M6, formatting Receipts with rule ID and file:line, and provide source snippet extractor at recorded file:line for analysed sha with clipboard copy payload
    - Wire normalization, metadata fetch, archive extraction, inventory, signal detection, verdict calculation, and receipt formatting into runGrimoireAutopsy
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_
  - [x] 4.8 Write unit and integration tests for Grimoire core Node engine
    - Write unit tests in test/grimoire/normalize.test.ts validating URL parsing permutations, default-branch ref notices, host rejections, and outbound URL constraints
    - Write unit tests in test/grimoire/archive.test.ts asserting archive size limits, symlink rejections, LFS filtering, and UTF-8 encoding validation
    - Write unit tests in test/grimoire/signals.test.ts and test/grimoire/verdict.test.ts asserting signal sorting, comment suppression, dead/alive logic, and lifespan calculation
    - Write integration tests in test/grimoire/autopsy.test.ts validating end-to-end autopsy generation on offline repository fixtures matching golden receipts and Last_Words
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 2.8, 2.9, 3.1, 3.4, 3.11, 3.12, 4.1, 4.2, 4.3, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

- [x] 5. Grimoire M2 request adapter, M3-M6 guidance and the JavaScript gate
  - [x] 5.1 Implement native fetch CommonJS Request_Adapter
    - Implement requestCompat in lib/grimoire/request-compat.cjs providing a CommonJS callback interface over native fetch
    - Enforce ALLOWED_KEYS validation on options object, throwing UnsupportedOption when unknown keys are passed
    - Invoke callback exactly once per call with (err, response, body), passing err = null on HTTP 4xx/5xx responses with response.statusCode populated
    - Support json: true parsing on non-empty bodies and invoke callback with network errors on connection failures
    - _Requirements: 7.11, 7.12, 7.13, 7.14, 7.15, 7.16_
  - [x] 5.2 Implement M2 request call site scanner and AST rewriter
    - Implement M2 transform in lib/rules/m2-request.ts tagging require('request'), import request, and request-promise variants
    - Flag request-promise usages as unknown with request_promise_unsupported without editing
    - Validate call sites for Eligible_Call_Site criteria, recording unknown with request_unsupported_call if defaults, jar, pipe, stream, on, or return values are used
    - When all call sites in a file are eligible, rewrite specifier to request-compat.cjs, mark compat: true and behavior: "unknown", and place adapter at manifest root
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
  - [x] 5.3 Implement M2 package manifest dependency updater and Node 22 engines setter
    - Implement manifest update functions in lib/rules/m2-manifest.ts removing request from package.json dependencies when no file in the manifest directory imports request
    - Keep request in dependencies and record unknown if any file in the manifest directory still imports request after M2 edits
    - Set engines.node to ">=22" with note "requires Node 22 or later" when M2 fires and engines.node is absent or below Node 22
    - Leave unparseable engines.node configurations unchanged while recording engines_unparseable
    - _Requirements: 7.7, 7.8, 7.9, 7.10_
  - [x] 5.4 Implement M3 package classifier, CommonJS-to-ESM guidance, and M4 Vite guidance
    - Implement package classifier in lib/rules/m3-m4-guidance.ts sorting package.json into ESM, monorepo workspace, application, or library
    - Keep libraries and monorepos in CommonJS, recording unknown with reference U4, and convert application packages via AST transforms when M3 is enabled
    - Skip M3 file conversion and record unknown if file contains __dirname, __filename, require.resolve, or conditional require
    - Target current stable Vite version for M4 looked up at runtime and record CommonsChunkPlugin mapping as unknown
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  - [x] 5.5 Implement M5 version drift reporting and M6 missing lock file detection
    - Implement guidance rules in lib/rules/m5-m6-guidance.ts identifying Node dependencies 2 or more major versions behind npm registry
    - List drifted dependencies in report while keeping versions unchanged unless another rule forces a bump
    - Record M5 for Python dependencies as unknown, and record registry_unavailable on failed registry lookups
    - Emit M6 signals for any manifest directory lacking a supported package lock file
    - _Requirements: 8.6, 8.7, 8.8, 8.9, 8.10_
  - [x] 5.6 Implement JavaScript and TypeScript syntax gate with step rollback
    - Implement gateJs in lib/grimoire/gate-js.ts using @babel/parser, parsing original files as module if .mjs or package.json type is "module", else script, recording original_unparseable on failure
    - Parse patched files as module if changed by an unreverted M3 step, else in original mode; on parse failure, iteratively revert last unreverted step with parse_failed, recompute mode, and reparse until valid
    - Mark patch steps with zero accepted edits as reverted with reason all_edits_rejected
    - Implement Candidate check verifying all changed JS/TS files parse, emit gate.result event, enforce mandatory gate before task merge, and return gate failure reasons to Builder without advancing to Warden review or recording Warden rejection
    - _Requirements: 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.11, 9.12, 9.13_
  - [x] 5.7 Write unit tests for M2 adapter, guidance rules, and JS syntax gate
    - Write test/grimoire/gate-js.test.ts testing request-compat.cjs callback invocation, error handling, status code propagation, and JSON parsing
    - Test M2 AST transform call site eligibility checks, manifest dependency cleanup, and Node 22 engines updates
    - Test M3 package classification, M4-M6 guidance rules, and registry failure handling
    - Test gate-js parsing modes, step rollback on parse failure, candidate gate verification, and gate.result event emission
    - _Requirements: 7.1, 7.3, 7.5, 7.7, 7.9, 7.11, 7.13, 7.14, 8.1, 8.5, 8.6, 8.10, 9.4, 9.5, 9.7, 9.8, 9.9, 9.11, 9.12, 9.13_
  - [x]* 5.8 Write property test for Traceability
    - **Property 1: Traceability (P1)**
    - **Validates: Requirements 6.1**
    - Verify with fast-check in test/props/traceability.test.ts that for every patch p in the output, p.ruleId is in {M1, M2, M3, M4, M5, M6}
    - _Requirements: 6.1_
  - [x]* 5.9 Write property test for Adapter status
    - **Property 3: Adapter status (P3)**
    - **Validates: Requirements 7.12**
    - Verify with fast-check in test/props/adapter-status.test.ts that for every response with HTTP status 400 or above and no network error, the adapter calls back with err = null
    - _Requirements: 7.12_
  - [x] 5.10 Implement fixture pinning, golden output baking and the golden test runner
    - Write scripts/fixtures/pin.ts (npm run pin:fixtures) creating 01_evidence/fixtures/<owner>-<repo>@<sha>/ with the files the detector reads at their original paths, the project's LICENSE, meta.json (frozen RepoMeta including asOf, stars and Last Words) and registry.json (frozen npm registry answers for M5), indexed in 01_evidence/fixtures/repos.json; shas come from the script and are never typed by hand, and a new sha gets a new folder.
    - Commit a fixture only when its license permits redistribution (unknown U15, checked per fixture); fixture inputs never call GitHub or the npm registry and use the pinned asOf.
    - Write scripts/fixtures/bake.ts (npm run bake:presets) running the Grimoire Node pipeline on each fixture and writing test/golden/<owner>-<repo>/ (all.patch and report.json at this point); task 19.4 extends it to write the Grimoire bundle.
    - Write test/golden/golden.test.ts (npm run test:golden) comparing fresh output for every committed fixture with the committed bytes.
    - _Requirements: 4.11_

- [x] 6. EventStore, RunStore, SSE stream and the read API routes /api/health, /api/run-autopsy (wired to detection and dead or alive), run start, /api/history and the run events routes named in design R4-10
  - [x] 6.1 Implement EventStore SQLite schema and append-only event stream
    - Create lib/events/event-store.ts with an SQLite table keyed by (runId, seq), assigning gap-free sequence numbers in the insert transaction and prohibiting row updates or deletions.
    - Implement event envelope storage holding runId, seq, ts from Necromancer clock, kind, actor, data with evidence references (data.refs[]), and optional skeletonId, taskId, and attempt.
    - Implement admin.redaction event append support and write events.ndjson export streaming from stored event rows in lib/events/event-export.ts.
    - _Requirements: 32.1, 32.2, 32.3, 32.4, 32.5, 32.10_
  - [x] 6.2 Implement EventTap redaction and raw command output log storage
    - Create lib/events/event-tap.ts to redact sensitive secrets, keys, and tokens from event payloads before persistence in EventStore and apply redactions on read paths.
    - Create lib/events/log-store.ts to store raw command output externally indexed by logRef, ensuring logs are redacted and storing only output tails in events.
    - _Requirements: 32.11, 32.13, 32.14_
  - [x] 6.3 Implement RunStore SQLite persistence and restart reconciliation
    - Create lib/runs/run-store.ts using SQLite on /data to persist run records, lifecycle phases, outcomes, sandbox identifiers, and run-scoped approved patterns.
    - Implement boot reconciliation logic reading living runs from RunStore on Necromancer restart, resuming runs with re-attached sandboxes or marking lost boxes as error.
    - Implement hashed invite code lookup, expiration, and remaining run count tracking in lib/runs/run-store.ts.
    - _Requirements: 31.3, 32.9_
  - [x] 6.4 Implement live SSE event streaming and Replay event routes
    - Create app/api/runs/[runId]/events/route.ts serving live events over SSE with event ID matching sequence number, ensuring browser disconnection does not terminate active runs.
    - Support Last-Event-ID reconnection header by querying EventStore from Last-Event-ID + 1 before tailing live events.
    - Support ?from=&to= query parameters returning stored events as JSON in sequence order for Replay with read-path redaction applied.
    - _Requirements: 32.6, 32.7, 32.8, 32.12, 33.11_
  - [x] 6.5 Implement autopsy API route wired to detection and dead-or-alive verdict
    - Create app/api/run-autopsy/route.ts validating repository URLs, fetching GitHub metadata, and enforcing a 20-second request watchdog timeout.
    - Enforce archive limits rejecting archives exceeding 20 MB compressed, 60 MB decompressed, 2000 entries, or containing symlinks, hardlinks, traversal segments, or absolute paths.
    - Wire request handling to Grimoire AST detection and dead-or-alive verdict calculation from Task 4, setting asOf to request timestamp and generating template-only cause text without executing code or calling models.
    - _Requirements: 2.1, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.13, 2.14, 2.15, 3.10, 5.8_
  - [x] 6.6 Implement public health status and history listing API routes
    - Create app/api/health/route.ts returning live-run status as open, queue length, paused by owner, or unavailable based on Admission and backend state.
    - Create app/api/history/route.ts querying RunStore for runs with recorded admin.publish events, listing all outcomes with equal weight and displaying removed runs as "Removed by the owner".
    - Support ?limit= query parameter for Gate recent runs and ?fields=kiro query parameter for Built with Kiro evidence queries.
    - _Requirements: 33.3, 33.5, 33.10, 34.1, 34.3, 34.4, 34.5, 39.13, 41.14_
  - [x] 6.7 Implement run start API route and initial admission queueing
    - Create app/api/start-run/route.ts accepting { url, sha, inviteCode } payloads and validating invite codes against hashed codes in RunStore.
    - Create run record in RunStore, append run to admission FIFO queue, emit run.queued event with queue position, and return HTTP 202 with runId.
    - Reject requests when invite code is missing, invalid, expired, revoked, or when run limits are reached, and enforce single live run capacity under InstaboxDockerBackend.
    - _Requirements: 31.2, 31.6, 31.10, 34.11_

- [x] 7. ExecutionBackend development implementation and Box hardening (Req 21 and the development criteria of Req 43)
  - [x] 7.1 Define ExecutionBackend interface, types, and specification validator
    - Create lib/backend/types.ts and lib/backend/execution-backend.ts defining ExecutionBackend, Sandbox, SandboxSpec, ExecRequest, ExecProcess, and ExecResult interfaces, selecting backend via EXECUTION_BACKEND.
    - Implement specification validator in lib/backend/spec-validator.ts rejecting specs with user ID 0, secrets or ports fields, environment variables matching the secret denylist, or commands formatted as shell strings instead of argv arrays.
    - Implement syncOut validator utility in lib/backend/sync-validator.ts rejecting absolute paths, parent directory traversals, .git/ or .kiro/ paths, symlinks, and files exceeding size limit while including sources and manifests.
    - _Requirements: 21.2, 21.3, 21.5, 21.14, 21.15, 43.1, 43.2, 43.3, 43.4, 43.7_
  - [x] 7.2 Implement per-run container network isolation and egress CONNECT proxy
    - Create lib/backend/connect-proxy.ts establishing an allowlist HTTP/HTTPS CONNECT forward proxy permitting only confirmed hosts (registry.npmjs.org, pypi.org, files.pythonhosted.org, github.com, codeload.github.com).
    - Block access to Kiro host list recorded by probe P11, api.github.com, and cloud metadata addresses (169.254.169.254).
    - Create lib/backend/network-policy.ts to provision a dedicated per-run internal Docker network (--internal) routing traffic solely through the CONNECT proxy and keeping network policy immutable during a run.
    - _Requirements: 21.9, 21.10, 21.11, 21.12, 43.8, 43.11_
  - [x] 7.3 Implement InstaboxDockerBackend container lifecycle and filesystem isolation
    - Create lib/backend/instabox-docker-backend.ts provisioning Docker containers from pinned digest image with Node and Python toolchains, dropping all capabilities, setting no-new-privileges, read-only root, and tmpfs scratch.
    - Configure isolated filesystem mounts bind-mounting only builders/ into Runbox and only warden/ into Auditbox, strictly forbidding mounts of KIRO_HOME, host user home, /data, or .git directories.
    - Implement idempotent creation returning existing sandbox when idempotencyKey matches, implement container destruction on run termination without snapshots, and implement get and list methods for restart recovery.
    - _Requirements: 21.1, 21.2, 21.4, 21.6, 21.7, 21.8, 21.16, 43.5, 43.9, 43.10, 43.18_
  - [x] 7.4 Implement streaming sandbox_exec execution and container process sweeping
    - Create lib/backend/docker-exec-stream.ts to execute commands inside boxes via docker exec accepting commands strictly as argv arrays, assigning sequential chunk numbers, and supporting stream resumption from requested sequence numbers.
    - Implement process cleanup killing the command process group and sweeping all remaining container-user processes upon command completion to prevent background process persistence.
    - Capture stdout and stderr tails, enforce memory and timeout exit statuses (oomKilled, timedOut), and store complete logs by logRef.
    - _Requirements: 20.11, 20.12, 21.13, 43.2, 43.6_

- [x] 8. Exhume harness and death certificate (Req 11)
  - [x] 8.1 Implement repository size check and base worktree cloning in GitService
    - In lib/git/git-service.ts, implement pre-clone size check comparing GitHub metadata size against configured repository size cap, refusing run before cloning if size exceeds cap.
    - Implement cloning of resolved base commit sha into git/ directory and create base worktree at builders/base with git hooks and fsmonitor disabled.
    - Write unit tests in test/git/git-service.test.ts verifying size refusal, clean worktree creation, and isolation from host git settings.
    - _Requirements: 11.1, 11.2, 11.3_
  - [x] 8.2 Implement manifest inspection and script detection rules
    - Create lib/exhume/script-detector.ts to inspect repository manifest files across Node (package.json) and Python (pyproject.toml, setup.py, pytest files).
    - Implement rules identifying absence of build scripts (marking build not run with reason) and default placeholder test commands.
    - Record "No tests found" with triggering rule ID when tests are missing or default placeholders in Node, or when Python pytest collect returns exit code 5.
    - _Requirements: 11.9, 11.10_
  - [x] 8.3 Implement Exhumer harness baseline command execution in Runbox
    - Create lib/exhume/exhume-harness.ts to provision Runbox and Auditbox via ExecutionBackend and execute baseline commands in Runbox without model calls: runtime versions, install, build, and test.
    - Pass --ignore-scripts on npm install commands, select pip or poetry based on detected manifests, execute lockfile-aware retry on install failure (marking build and tests not run if retry fails), and emit command.started and command.result events.
    - Enforce run wall-clock timeout during Exhume, retaining completed rows and marking unreached rows as not run with reason time limit.
    - _Requirements: 11.4, 11.5, 11.6, 11.7, 11.8, 11.14, 11.16, 20.13_
  - [x] 8.4 Implement Grimoire base analysis, triage classification, and Death Certificate storage
    - In lib/exhume/triage.ts, run Grimoire rules on base tree emitting grimoire.signal and grimoire.summary events, and parse harness command logs to classify baseline failure classes.
    - Implement Exhumer triage session interface targeting Claude Haiku 5.5 to synthesize log findings into the Death Certificate data structure in lib/exhume/death-certificate.ts.
    - Persist Death Certificate, emit exhume.certificate event, and support early completion setting outcome to healthy_already when install, build, and tests pass and user stops.
    - _Requirements: 11.11, 11.12, 11.13, 11.15_

- [x] 9. Agent templates, model allowlist and SkeletonSupervisor ACP channel
  - [x] 9.1 Author committed agent templates for Skeleton roles
    - Create committed Markdown agent templates in lib/agents/templates/ for Planner, Exhumer, Bonesetter, Soul-stitcher, Warden, and Scribe defining role tools and write boundaries.
    - Configure role tools: Planner (read, write on spec/**, report_task_result, ask), Exhumer (read, sandbox_exec, sandbox_log, report_task_result), Bonesetter (read, write on manifest and lock files, sandbox_exec, sandbox_log, report_task_result, ask, report_blocker, ack_message), Soul-stitcher (Bonesetter tools plus propose_task, write outside .git/** and .kiro/**), Warden (read, sandbox_exec, sandbox_log, warden_verdict, no write tool), and Scribe (read, write on report/**, report_task_result, ack_message).
    - Enforce universal agent constraints: set excludedTools to ["shell", "web", "subagent"], deny shell, web_fetch, web_search, and subagent permissions, deny fs_read on **/.env, **/.env.*, **/*.pem, and **/id_*, deny fs_write on **/.git/** and **/.kiro/**, set includeMcpJson to false, set includePowers to false, and disable sub-agents.
    - _Requirements: 14.1, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.12, 14.15_
  - [x] 9.2 Build Skeleton workspace, isolated KIRO_HOME, and environment provisioner
    - Implement lib/supervisor/skeleton-env.ts to provision isolated per-Skeleton directory trees under /data/runs/<runId>/homes/<skeletonId>/ and copy role agent templates unchanged into $KIRO_HOME/agents/<role>.md.
    - Configure Skeleton $KIRO_HOME with chat.disableInheritingDefaultResources set to true and write task steering resources containing Grimoire guidance within 32 files and 100,000 characters.
    - Provide each Skeleton with an isolated HOME directory so ~/.kiro/agents/ resolves per Skeleton if probe P4 indicates agents are not loaded from $KIRO_HOME/agents/.
    - Assign dedicated worktree paths under builders/<wt>/ for Soul-stitchers and ensure Warden operates in an isolated session, process, KIRO_HOME, checkout under warden/, and Auditbox disjoint from all Builders.
    - _Requirements: 14.2, 14.13, 14.14, 14.16, 14.17, 14.18, 45.6_
  - [x] 9.3 Implement model allowlist and role tier registry
    - Implement lib/supervisor/model-allowlist.ts maintaining an allowlist of exactly the three model IDs recorded by Probe P4 for Claude Haiku 5.5, Claude Sonnet 5.5, and Claude Opus 5.5, explicitly excluding Auto.
    - Map default model tiers to roles: Claude Opus 5.5 for Planner and Warden, Claude Sonnet 5.5 for Bonesetters and Soul-stitchers, and Claude Haiku 5.5 for Exhumer triage and Scribe.
    - Implement tier escalation assigning Claude Opus 5.5 to Soul-stitchers for tasks marked hard: yes, while keeping live runs disabled if Probe P4 records no allowed model and keeping effort at default until Probe P4 records effort values.
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.9, 15.10_
  - [x] 9.4 Implement Skeleton process spawn and ACP client transport
    - Implement lib/supervisor/acp-client.ts to spawn kiro-cli acp --agent-engine=v3 as unprivileged user skel with process environment set to exactly KIRO_API_KEY, KIRO_HOME, HOME, and PATH.
    - Register JSON-RPC handlers for session/update and session/request_permission prior to sending session/new.
    - Reply with JSON-RPC error to all incoming fs/*, terminal/*, and unknown client requests while Probe P2 has not recorded Kiro invoking them.
    - Store advertised capabilities from initialize response, send optional methods only when advertised, and fail spawn with reason auth_failed while halting Admission if initialize asks for login.
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.18_
  - [x] 9.5 Implement ACP session negotiation, verification, and lifecycle management
    - Implement lib/supervisor/acp-session.ts to establish sessions via session/new with Skeleton working directory, MCP gateway endpoint with per-Skeleton bearer token, role modeId, modelId, policy presets (edit-workspace for Planner/Soul-stitcher/Scribe, read-workspace for Exhumer/Bonesetter/Warden with Bonesetter manifest allow rule), and Planner additionalDirectories containing read-only repository snapshot.
    - Read active model from configOptions and active mode from session response; fail Skeleton with reason model_mismatch before any prompt if model is outside allowlist or differs from role tier, or if active mode is not the role agent; verify MCP gateway connectivity via advertised status method or gateway connection records, failing Skeleton with gateway_missing if disconnected; emit skeleton.raised with verified model ID, sessionId, and agent once checks pass.
    - Dispatch session/prompt containing tasks.md item text, death certificate rows, and Grimoire guidance, treating calls complete only on prompt response; deliver corrections via _session/steer if advertised, or wait for tool completion, session/cancel, prompt response, and reprompt; handle cancel with 10s wait, SIGTERM, and SIGKILL (5s); handle crash with single respawn and session/load sending continue without lost prompt; archive homes/<id>/sessions into run evidence and delete remaining KIRO_HOME on finish.
    - _Requirements: 15.5, 15.6, 15.7, 15.8, 16.7, 16.8, 16.9, 16.10, 16.12, 16.13, 16.14, 16.15, 16.16, 16.17, 16.21, 41.20, 41.21, 45.12_
  - [x] 9.6 Implement EventTap update stream processor and usage routing
    - Implement lib/supervisor/event-tap.ts to process incoming session/update streams, tagging events with run, Skeleton, task, and toolCallId, redacting secrets, and persisting to EventStore before SSE distribution.
    - Map tool calls to skeleton.tool_call and skeleton.tool_result events, agent text to skeleton.log events with stream agent, and session_info_update with turn_completion to skeleton.usage events.
    - Route context_usage received in session/update directly to the BudgetGovernor.
    - _Requirements: 16.11, 16.19, 16.20_
  - [x]* 9.7 Write property test for Model allowlist
    - **Property 17: Model allowlist (P17)**
    - Name test file test/props/model-allowlist.test.ts and verify that no session/prompt is sent to a session whose active model read from configOptions after session/new is outside the three allowed IDs or differs from the role tier.
    - **Validates: Requirements 15.1, 15.5, 15.6**

- [x] 10. PermissionBroker, MCP gateway tools and command policy
  - [x] 10.1 Implement PermissionBroker decision engine and option selection
    - Implement lib/broker/permission-broker.ts to answer incoming session/request_permission requests by selecting exactly one option of kind allow_once or reject_once, never selecting allow_always or reject_always, and leaving permissions.yaml unchanged.
    - Decide solely on host-supplied identity (toolCallId, _meta.kiro.consent, _meta.kiro.mcpTool) and arguments without inspecting request title or MCP annotations, defaulting unmatched requests to reject_once.
    - Select options exclusively from offered options matching verified shapes from probe P6, falling back to the documented-safe permission form if probe P6 shows designed rules diverge.
    - Cancel the turn, answer cancelled, and emit permission.anomaly if no one-time option of the needed kind is offered; emit permission.decision with requestId, toolCallId, role, capability, target, option kind, and matched rule on every decision.
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.13, 18.15, 45.7_
  - [x] 10.2 Implement PermissionBroker role boundaries and watchdog timeout
    - Implement lib/broker/broker-rules.ts defining capability rules: evaluate fs_read to allow within cwd or additionalDirectories outside secret globs and reject elsewhere (/proc/**, KIRO_HOME, home directories, symlink targets outside root).
    - Evaluate fs_write to allow inside role write scopes (Planner spec/**, Bonesetter manifests, Soul-stitcher worktree outside .git/**/.kiro/**, Scribe report/**) and reject all other writes, all writes from Exhumer and Warden, and any writes to .git/** or .kiro/**.
    - Evaluate mcp calls to allow necromancer/* tools listed for the role and reject unlisted gateway tools or other servers; reject all calls for shell, web_fetch, web_search, subagent, skill, and power.
    - Enforce the watchdog limit from Admin Required_Setting, selecting reject_once, logging a Necromancer bug, and emitting permission.anomaly if a request remains unanswered past the limit.
    - _Requirements: 18.6, 18.7, 18.8, 18.9, 18.10, 18.11, 18.12, 18.14, 41.23_
  - [x] 10.3 Implement committed Command Policy engine and hard blocks
    - Implement lib/gateway/command-policy.ts and committed policy file lib/gateway/command-policy.json to classify command argv arrays strictly as allowed, needs_approval, or blocked, formatting policy for Admin page inspection.
    - Classify inside-worktree commands as allowed: git status, git diff, git log, git add, git commit, and git checkout -b; package installs (npm ci, npm install, pip install -r, poetry install); npm run (build, test, lint, typecheck); pytest; python -m unittest; version commands; ensure Exhumer harness passes --ignore-scripts.
    - Classify all commands matching the Hard_Block list as blocked: Kiro API key, GitHub tokens, environment dumps, ~/.ssh, cloud metadata IP, sudo, container sockets, and host mounts.
    - Classify all other commands as needs_approval, including commands that name network hosts outside the egress allowlist.
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.12, 20.13, 29.10, 29.11, 29.12_
  - [x] 10.4 Implement command approval workflow and grant tracking
    - Implement lib/gateway/approval-manager.ts emitting approval.requested and returning status approval_pending with approvalId and expiresAt when a command classifies as needs_approval.
    - Bind one-time approval grants to (skeletonId, sha256(argv), cwd) for at most one future execution, treating grants as void if presented after expiresAt.
    - Support run-scoped pattern approvals stored in RunStore without altering Kiro permission files, and treat unanswered requests past deadline as denied to trigger Skeleton re-planning.
    - Refuse blocked commands by starting no process in any Box, emitting command.refused with argv and reason, and returning status blocked to the Skeleton.
    - _Requirements: 20.6, 20.7, 20.8, 20.9, 20.10, 20.14_
  - [x] 10.5 Implement MCP Gateway server, bearer authentication, and transport
    - Implement lib/gateway/mcp-gateway.ts running an HTTP MCP server on 127.0.0.1 with per-Skeleton bearer tokens, re-checking role and tool validity on every invocation.
    - Restrict gateway tools by role: sandbox_exec and sandbox_log (Exhumer, Bonesetter, Soul-stitcher, Warden); report_task_result (Planner, Exhumer, Bonesetter, Soul-stitcher, Scribe); warden_verdict (Warden); ask (Planner, Bonesetter, Soul-stitcher); report_blocker (Bonesetter, Soul-stitcher); propose_task (Soul-stitcher); ack_message (Bonesetter, Soul-stitcher, Scribe); refuse calls from unlisted roles.
    - Implement fallback connection via stdio shim over Unix socket spawned with environment omitting KIRO_API_KEY if probe P3 indicates HTTP gateway unsupported in session/new, keeping Kiro internal sandboxing disabled if probe P9 shows bwrap failure.
    - _Requirements: 19.1, 19.3, 19.4, 19.14, 45.9_
  - [x] 10.6 Implement MCP execution tools and backend dispatch
    - Implement lib/gateway/execution-tools.ts executing sandbox_exec by validating that cwd lies within the caller worktree, dispatching builder commands to Runbox and Warden commands to Auditbox strictly as argv arrays.
    - Enforce command execution bounded below the MCP request timeout recorded by probe P3; emit command.started and command.result.
    - Return exit_code, stdout_tail, stderr_tail, truncated, and log_ref on bounded completion, or status running with log_ref for continuing executions; implement sandbox_log to return log output slices by offset and limit, returning exit status once finished.
    - Invoke ExecutionBackend process-group kill and sweep remaining processes of the container user immediately upon sandbox_exec completion.
    - _Requirements: 19.5, 19.6, 19.7, 19.8, 19.9, 19.10, 19.19, 20.11_
  - [x] 10.7 Implement MCP collaboration tools
    - Implement lib/gateway/collaboration-tools.ts providing report_task_result recording typed task results with taskId, status, summary, and refs.
    - Implement warden_verdict validating presence of target, verdict of approve or reject, reasons with refs, and candidateSha256, refusing calls with missing fields.
    - Implement ask returning immediately with "recorded; end your turn" while queuing the question for answer delivery via steer or new prompt.
    - Implement propose_task recording proposals for user confirmation prior to scope changes, report_blocker recording blocker text and kind for mitigation, and ack_message marking messages as Acknowledged.
    - _Requirements: 19.2, 19.11, 19.12, 19.13, 19.15, 19.16, 19.17, 19.18_
  - [x]* 10.8 Write property test for One-time permission answers
    - **Property 12: One-time permission answers (P12)**
    - Name test file test/props/one-time-permission-answers.test.ts and verify that for every session/request_permission answered by PermissionBroker, the selected option has kind allow_once or reject_once, no answer ever selects allow_always or reject_always, and permissions.yaml never changes.
    - **Validates: Requirements 18.1, 18.2, 18.3**
  - [x]* 10.9 Write property test for Hard-blocked commands never run
    - **Property 19: Hard-blocked commands never run (P19)**
    - Name test file test/props/hard-blocked-commands.test.ts and verify that for every sandbox_exec call whose argv classifies as blocked, no process starts in any box and command.refused is stored, and needs_approval commands run only after matching approval grants.
    - **Validates: Requirements 20.4, 20.6, 20.7, 20.8, 20.10, 29.10, 29.11, 29.12**

- [x] 11. Host-side isolation, untrusted repository Kiro content, redaction and secrets
  - [x] 11.1 Implement host isolation, user permissions, and Kiro system settings
    - Implement scripts/host-isolation.sh and lib/security/host-policy.ts configuring the skel user with no docker or sudo membership and no read access to Necromancer files, and verifying kiro-cli version 3.1.0 checksum against release manifest.
    - Create root-owned KIRO_DEFAULT_SETTINGS file enforcing telemetry.enabled false and app.disableAutoupdates true, verify Share Kiro content opt-out, and refuse to start live runs if opt-out is unset.
    - Configure host firewall rules restricting skel user outbound network traffic strictly to Kiro service hosts recorded by probe P11 and loopback MCP gateway.
    - Enforce UI server execution under a separate unprivileged user holding no secrets and restricted to loopback API communication.
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.13, 42.14, 42.16, 42.18_
  - [x] 11.2 Implement Git repository isolation and untrusted Kiro content neutralization
    - Implement git directory isolation in lib/git/git-service.ts keeping git repositories under /data/runs/<runId>/git/ outside all Box mounts and running git commands exclusively as necro with core.hooksPath=/dev/null and core.fsmonitor=false.
    - Scan cloned repository in lib/security/untrusted-content.ts for untrusted .kiro/ directories, AGENTS.md files, and skills, removing them from worktree view and marking them with skip-worktree when probe P7 indicates ACP loads repository configuration.
    - Enforce Candidate diff validation in lib/security/scope-check.ts rejecting any diff touching .kiro/ or .git/.
    - _Requirements: 22.6, 22.7, 22.10, 22.11, 22.12, 45.17_
  - [x] 11.3 Implement worktree symlink scanner and escape quarantine
    - Implement lib/security/symlink-scanner.ts scanning Skeleton worktrees before sending each prompt and after each sandbox_exec command.
    - Enforce mandatory symlink scanning across worktrees before every prompt and after every sandbox_exec where probe P12 shows file tools follow symlinks.
    - Detect symlinks resolving outside the worktree root, immediately terminating the Skeleton process, quarantining the worktree, and failing the run.
    - _Requirements: 22.8, 22.9, 45.10_
  - [x] 11.4 Implement Redactor engine and worktree secret scanner
    - Implement lib/security/redactor.ts redacting events and command logs prior to EventStore persistence or disk writes.
    - Replace exact values of Necromancer secrets (Kiro key, GitHub tokens, Docker PAT, admin secret, Invite_Codes) and scrub patterns ksk_, ghp_, github_pat_, dckr_pat_, AKIA, and -----BEGIN.
    - Replace host paths (/data/home, C:\Users) and Box internal network addresses in logs and event payloads.
    - Scan changed worktree files before sandbox_exec and Candidate diffs before Grimoire gate submission, quarantining the worktree upon detecting secret patterns.
    - _Requirements: 22.14, 22.15, 42.1, 42.2, 42.3, 42.4, 42.5_
  - [x] 11.5 Implement credential vault and secret placement constraints
    - Implement lib/security/credential-vault.ts maintaining Kiro API key only in a single necro-readable file in development or host secret store in production, in memory, and in child kiro-cli process env, using distinct keys for dev and prod.
    - Enforce exclusion of Kiro key and Instabox API key from Box environments, Box files, stored events, logs, artifacts, and repository, keeping Instabox API key on Owner local machine.
    - Secure GitHub tokens inside GitService, Docker PAT in production host secret store, admin secret out of UI bundles, and dev box SSH address out of repo, documentation, and events.
    - Support admin review and redaction workflow prior to publishing runs to History or Replay.
    - _Requirements: 42.7, 42.8, 42.9, 42.10, 42.11, 42.12, 42.13, 42.15, 42.17, 42.19, 42.20_
  - [x] 11.6 Implement CI secret redaction canary tests
    - Implement test/security/canary.test.ts planting canary tokens (ksk_CANARY..., ghp_CANARY..., AKIA_CANARY...) into a repository file, command stdout/stderr, and tool result payload.
    - Run canary test suite in CI pipeline, verifying that no canary token appears downstream of EventTap, in EventStore, or in generated artifacts.
    - _Requirements: 42.6_
  - [x]* 11.7 Write property test for Kiro key containment
    - **Property 11: Kiro key containment (P11)**
    - Name test file test/props/kiro-key-containment.test.ts and verify that for every box created by either backend, the Kiro API key value does not occur in env, files, stored events, command logs, or artifacts, including canary keys.
    - **Validates: Requirements 21.5, 42.6, 42.7, 42.8**

- [x] 12. Pact planning, parser, renderer, review, approval and the Pact API routes
  - [x] 12.1 Implement Pact parser and grammar validation
    - Parse tasks.md checkbox lines matching - [ ] T<n>. <title> followed by metadata bullets role, depends, files, accept, hard, and rules in lib/pact/pact-parser.ts.
    - Validate task IDs matching T<n> without duplicates, roles restricted to bonesetter or soul-stitcher, dependencies referencing defined tasks without cycles, and file paths within repository bounds.
    - Validate execution constraints: verify accept commands do not classify as blocked under CommandPolicy, hard is yes or no, and rules cites only M1 through M6.
    - _Requirements: 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11_
  - [x] 12.2 Implement Pact renderer with round-trip idempotence
    - Implement lib/pact/pact-renderer.ts rendering parsed Pact data models back into standard tasks.md Markdown text matching the exact parser grammar.
    - Format each task as - [ ] T<n>. <title> followed by indented metadata bullets role, depends, files, accept, hard, and rules.
    - Guarantee round-trip idempotence such that rendering any valid parsed Pact and reparsing produces an equivalent parsed Pact data structure.
    - _Requirements: 12.12, 12.13_
  - [x] 12.3 Implement Planner session orchestration and failure coverage check
    - Implement lib/pact/pact-planner.ts to raise the Planner session upon user request after DeathCertificate is stored, supplying autopsy signals, DeathCertificate, and Grimoire signals as prompt inputs with writes sandboxed to spec/.
    - Require Planner to write spec/requirements.md, spec/design.md, and spec/tasks.md prior to calling report_task_result, locking Warden final check, Scribe report, and Grimoire_Gate as non-removable requirements.
    - Execute coverage verification mapping every DeathCertificate failure to at least one task or categorizing it under Not addressed by any task.
    - Emit pact.drafted when parsing and coverage succeed, or display validation errors on the Pact screen without emitting pact.drafted, keeping Planner alive during Legion for asks and revisions.
    - _Requirements: 12.1, 12.2, 12.3, 12.14, 12.15, 12.16, 12.17, 13.5_
  - [x] 12.4 Implement Pact review, approval, parking, and resume lifecycle
    - Implement lib/pact/pact-service.ts pausing the run clock in pact_review phase, storing user edits as the next pactVersion, and emitting pact.edited.
    - Dispatch revision requests to Planner upon user demand, emitting pact.revision and requiring user approval before raising any new or revised task Skeleton during Legion.
    - Emit pact.approved with pactVersion, approvedTaskIds, and budget upon user approval, gating all Bonesetter, Soul-stitcher, Warden, and Scribe spawns behind approval.
    - Park runs exceeding the Pact idle limit by preserving the Pact and releasing the Runbox, and re-queue and re-clone the repository when the user resumes a parked run.
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.6, 13.7, 13.8, 13.9, 13.10, 13.11_
  - [x] 12.5 Implement Pact mutating API route
    - Implement app/api/runs/[runId]/pact/route.ts handling POST requests with actions edit, revise, approve, and stop.
    - Process edit actions to validate submitted tasks, increment pactVersion, and emit pact.edited; process revise to trigger Planner revisions and emit pact.revision.
    - Process approve actions to record user approval and emit pact.approved with pactVersion, approvedTaskIds, and budget; process stop to cancel the run.
    - Authenticate caller invite codes, enforce run phase constraints, and reject malformed requests or invalid task edits.
    - _Requirements: 13.2, 13.3, 13.4, 36.14_
  - [x] 12.6 Implement unit and integration tests for Pact subsystem
    - Implement test/pact/pact-parser.test.ts verifying grammar acceptance, duplicate ID rejection, cycle detection, blocked accept commands, and path bounds.
    - Implement test/pact/pact-renderer.test.ts verifying renderer formatting and round-trip parsing equivalence.
    - Implement test/pact/pact-service.test.ts verifying coverage checking, unremovable requirements, clock pausing, revision locking, approval events, parking on idle limit, and resume re-cloning.
    - _Requirements: 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13, 12.14, 13.1, 13.4, 13.6, 13.7_

- [x] 13. Scheduler with one Soul-stitcher, Warden review and merge rule, with all git work in lib/git/git-service.ts
  - [x] 13.1 Implement GitService repository, branch, worktree, and merge operations
    - Extend lib/git/git-service.ts from 8.1 and 11.2, keeping the flags -c core.hooksPath=/dev/null -c core.fsmonitor=false on every git call, and add creation of the Integration_Head branch graveyard/<runId>.
    - Implement task branch creation task/<taskId> from Integration_Head and provision isolated builder worktrees under builders/<taskId>, with automated cleanup on completion.
    - Implement candidate rebase of task/<taskId> onto Integration_Head, detecting rebase conflicts and requesting user conflict_choice.
    - Implement fast-forward merge of Integration_Head to Candidate sha upon Warden approval, and diff extraction for candidate scope checking and all.patch export.
    - _Requirements: 23.6, 25.1, 25.2, 25.6, 26.10_
  - [x] 13.2 Implement deterministic Scheduler dependency evaluation and slot controller
    - Implement lib/scheduler/scheduler.ts reading dependencies strictly from approved tasks.md without model calls, setting disabled tasks to skipped and pending tasks to ready when dependencies are merged.
    - Transition open tasks to blocked when dependencies fail, are abandoned, or are skipped, and raise a user ask; unblock tasks to ready when dependencies are re-planned.
    - Enforce live Skeleton concurrency boundaries against the minimum of the run parallel cap, global Skeleton limit, and ExecutionBackend runningMax.
    - Stop dispatching when all tasks are terminal, Stop is requested, or budget caps are exceeded; mark tasks failed after maximum attempts or abandoned when laid to rest.
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.8, 23.9, 23.10, 23.11, 23.12, 23.13, 23.14_
  - [x] 13.3 Implement Soul-stitcher task dispatch and prompt delivery
    - Implement lib/scheduler/dispatcher.ts dispatching ready tasks in tasks.md priority order, verifying task is within approvedTaskIds of the latest approved pactVersion.
    - Create task branch and worktree via GitService, assigning Claude Opus 5.5 if task is marked hard: yes and Claude Sonnet 5.5 otherwise.
    - Construct initial session/prompt containing tasks.md item text, death certificate failure rows, and relevant Grimoire guidance for cited M1-M6 rule IDs.
    - Spawn Soul-stitcher session via SkeletonSupervisor and advance task state to running.
    - _Requirements: 23.6, 23.7, 23.14, 23.15, 23.16_
  - [x] 13.4 Implement Warden lifecycle, auditbox environment, and candidate review
    - Implement lib/warden/warden-review.ts raising exactly one Warden (Opus 5.5) on pact.approved with isolated session, process, KIRO_HOME, checkout under warden/, and container auditbox with zero write tools.
    - Serialize Candidate reviews one at a time, resetting Auditbox checkout to Integration_Head plus Candidate patch and running install, build, task accept command, and repo tests.
    - Execute no_test_weakening check comparing test files and counts before and after change; validate reasons contain evidence refs (cmd:, file:, gh:, ev:), rerunning if all reasons lack refs.
    - Handle rejections by re-dispatching with reasons if rejectCount is below limit (reusing alive session or starting fresh session), or failing task and asking stuck_after_rejections when limit reached; execute final check on Integration_Head.
    - _Requirements: 24.1, 24.2, 24.4, 24.5, 24.6, 24.7, 24.8, 24.9, 24.10, 24.11, 24.12, 24.13, 24.14, 24.15, 24.16, 24.17, 25.9_
  - [x] 13.5 Implement Candidate submission pipeline, scope check, and merge gate
    - Implement lib/scheduler/candidate-submission.ts handling report_task_result, rebasing task branch onto Integration_Head via GitService, and verifying changes stay within files in scope.
    - Scan Candidate diff for credentials using redaction patterns, quarantining worktree, failing task, and alerting Owner on secret detection.
    - Execute Grimoire syntax gate on Candidate changes: emit gate.result with ok = false and return reasons to Builder without Warden review or incrementing rejectCount if invalid; emit gate.result with ok = true if valid.
    - Advance task to in_review and submit Candidate to Warden; upon approve Verdict matching candidateSha256 and unmoved head, fast-forward branch via GitService, emit task.state merged, and lay Skeleton to rest.
    - _Requirements: 9.11, 9.12, 9.13, 24.3, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.10, 25.11, 41.19_
  - [x]* 13.6 Write property test for Pact before Legion
    - **Property 10: Pact before Legion (P10)**
    - **Validates: Requirements 13.8, 13.9, 13.10, 23.7**
    - Verify with fast-check in test/props/pact-before-legion.test.ts that no builder skeleton is raised before pact.approved and only approved tasks run.
  - [x]* 13.7 Write property test for Warden isolation
    - **Property 13: Warden isolation (P13)**
    - **Validates: Requirements 14.7, 21.7, 21.8, 24.14, 24.15**
    - Verify with fast-check in test/props/warden-isolation.test.ts that Warden and builder environments, sessions, homes, worktrees, and containers remain completely disjoint.
  - [x]* 13.8 Write property test for Merge gate
    - **Property 16: Merge gate (P16)**
    - **Validates: Requirements 9.12, 25.6, 25.7, 25.8**
    - Verify with fast-check in test/props/merge-gate.test.ts that tasks transition to merged only when preceded by an approve verdict matching candidateSha256 and passing gate.result.

- [x] 14. Run completion and artifacts without the Scribe narrative
  - [x] 14.1 Implement run lifecycle phase state machine and outcome evaluator
    - Implement lib/lifecycle/lifecycle-manager.ts advancing runs through queued, exhume, plan, pact_review, legion, final_check, report, and done and emitting run.phase on each transition.
    - Support early phase exits on user stop, unrecoverable errors, budget stops, or healthy_already when no initial failures exist.
    - Evaluate final outcome to exactly one status among resurrected, resurrected_build_only, partial, not_resurrected, healthy_already, cancelled, killed, budget_stopped, and error.
    - Require final_check build and tests to pass for resurrected, or build to pass when repo has no tests for resurrected_build_only, and assign not_resurrected if install fails.
    - _Requirements: 26.1, 26.2, 26.3, 26.14, 41.1, 41.3_
  - [x] 14.2 Implement artifact collector and sha256 integrity manager
    - Implement lib/artifacts/artifact-collector.ts assembling run artifacts upon entering done phase: export all.patch from base sha to Integration_Head via GitService.
    - Gather spec bundle (requirements.md, design.md, tasks.md), DeathCertificate, structured report from event findings, and stream events.ndjson.
    - Compute sha256 checksums and byte sizes for each artifact file, persisting them immutably under /data/runs/<runId>/artifacts/.
    - Emit an artifact.ready event for each stored artifact containing its kind, path, sha256, and byte size.
    - _Requirements: 26.10, 26.11_
  - [x] 14.3 Implement artifact storage reader and retrieval API route
    - Implement app/api/runs/[runId]/artifacts/[kind]/route.ts handling GET requests for artifact kinds patch, spec, report, events, and certificate.
    - Read artifact bytes from storage and verify sha256 hash matches the digest recorded in the corresponding artifact.ready event.
    - Return stored bytes with appropriate Content-Type, Content-Disposition, and caching headers, rejecting requests for unready or missing kinds.
    - _Requirements: 26.11, 26.12_
  - [x] 14.4 Implement sandbox teardown and run finalization
    - Implement lib/lifecycle/run-finalizer.ts invoking ExecutionBackend.destroyBox() to destroy all containers (runbox and auditbox) associated with the run.
    - Verify complete box destruction and ensure zero residual container processes or host bind mounts remain.
    - Emit the terminal run.done event containing the run outcome, total duration, and artifact manifest once all artifacts are stored and boxes destroyed.
    - _Requirements: 26.13, 26.15_
  - [x] 14.5 Implement unit and integration tests for run completion and artifact persistence
    - Implement test/lifecycle/run-completion.test.ts testing all eight phase transitions and terminal outcome evaluations for resurrected, build-only, partial, and not_resurrected.
    - Implement test/artifacts/artifact-collector.test.ts testing all.patch export, spec bundling, events.ndjson streaming, and sha256 verification.
    - Test that run.done emits strictly after all artifacts are ready and all boxes are destroyed, and verify artifact retrieval endpoint verifies sha256 integrity.
    - _Requirements: 26.1, 26.2, 26.3, 26.10, 26.11, 26.12, 26.13, 26.14, 26.15_

- [x] 15. Slice UI: Gate, Tombstone, Pact screen, Legion dashboard cards, Reliquary, History and Replay (main path; task 24 adds the remaining states to the same files)
  - [x] 15.1 Implement the Gate screen main path
    - Write app/page.tsx, components/GateView.tsx and components/HealthBadge.tsx: the live-run badge from GET /api/health in text and icon (Live runs: open, Live runs: queue is N long, Live runs: paused by the owner, Live runs: unavailable), with "Checking the crypt..." while the request loads and the page still usable.
    - Validate the repository URL form and show a message that names the accepted URL forms; submit a valid URL and Invite_Code to POST /api/start-run.
    - Write components/RecentRuns.tsx listing Recorded_Runs from GET /api/history?limit=, each labelled "Recorded run" with repository, date and outcome, or "No recorded runs yet." when the list is empty.
    - Show the footer line "Skeleton sessions run on Kiro CLI. Git-Graveyard is an independent project." in every Gate state.
    - _Requirements: 34.1, 34.3, 34.4, 34.5, 34.6, 34.10, 34.11_
  - [x] 15.2 Implement the Tombstone main path: autopsy card, Signal_Chips, live Exhume and Death_Certificate
    - Write app/tomb/[owner]/[repo]/page.tsx and components/TombstoneView.tsx: a loading state without stage names, the repository name from the GitHub API full_name, the notice that the default-branch head is used when the input has a /tree/<ref> path, and the completed autopsy card (status, reasons, Last_Words as plain text with every markup character escaped, lifespan and years dead with asOf, stars, forks, languages, Signal_Chips and the sentence "Grimoire's instant verdict is rule-based and has not run your code.").
    - Write components/SignalChip.tsx and components/ReceiptViewer.tsx: chips grouped by rule ID M1 to M6, a Receipt with rule ID and file:line on every chip, a copy control that copies file:line, and a viewer that shows the source line at the recorded file:line of the analysed sha.
    - Write components/ExhumeView.tsx and components/CommandRow.tsx: before Exhume, list what will run, the caps from the Invite_Code and the queue state; while queued, show the waiting-room strip with the queue position; while running, add one row per command as it starts with command line, status, exit code, duration and View output, plus the elapsed clock and Cancel.
    - Write components/DeathCertificateView.tsx showing the Death_Certificate table and the button "Ask the Necromancer for a Pact", which navigates to /runs/[runId]/pact.
    - _Requirements: 1.4, 1.8, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 35.1, 35.8, 35.9, 35.11, 35.12, 35.13, 35.19_
  - [x] 15.3 Implement the Pact screen main path
    - Write app/runs/[runId]/pact/page.tsx and components/PactEditor.tsx: show "The Necromancer's Planner is writing the Pact" with the Necromancer channel visible while drafting, then the task list with the Warden final check, the Scribe report and the Grimoire_Gate as locked controls that state why they cannot be removed.
    - Show uncovered failures under "Not addressed by any task".
    - Write components/BudgetSettings.tsx showing the Invite_Code caps as a ceiling the user may lower, with the sentence "The cap is checked between tool calls. A single tool call may finish after the cap is reached."
    - Submit edits to POST /api/runs/[runId]/pact and render the returned pactVersion; on approval, open the Legion_Dashboard.
    - _Requirements: 36.1, 36.4, 36.7, 36.8, 36.11, 36.13, 36.14_
  - [x] 15.4 Implement the Run Header and the Legion dashboard main path
    - Write components/RunHeader.tsx for every run page: the stage ribbon, a "Now" sentence from the latest skeleton.tool_call, the "You" slot, the clocks, the budget meters and the line "You can leave this page. The run keeps going."
    - Write app/runs/[runId]/legion/page.tsx and components/LegionDashboard.tsx: while queued, one waiting-room card (position, number ahead, "Your place is kept", Cancel, link to a Replay) and no empty Skeleton cards; while starting, the sandbox-preparing state with the Exhumer card first; on done, "Open the Reliquary" with the cards still readable.
    - Write components/SkeletonCard.tsx showing role, task IDs, state as icon and text, attempt number, current tool call with its running time, log tail, elapsed time, credits or not reported, tool-call count and worktree name.
    - Write components/NecromancerChannel.tsx with filters for Decisions, Asks, Approvals and Messages and evidence links on every decision, and components/RunControls.tsx with Pause run, Resume and Stop run (Stop behind a confirmation) and Kill shown only to the Admin.
    - _Requirements: 37.1, 37.2, 37.3, 37.7, 37.10, 37.14, 37.15_
  - [x] 15.5 Implement the Reliquary main path
    - Write app/runs/[runId]/relic/page.tsx and components/ReliquaryView.tsx: the outcome banner from run.done.outcome in plain words, with "Resurrected" only when both the final-check build and the repository tests passed, and "Packing the relics" while artifacts are assembled.
    - Write components/BeforeAfterTable.tsx with the rows Install, Build, Tests (repository's own), Grimoire signals, Lockfile and Runtime used, each cell with status, exit code, duration and View output, and a separate row "Tests added by skeletons".
    - Write components/DiffViewer.tsx with every hunk tagged by task ID and Grimoire rule, using Monaco when it loads and a plain <pre> view otherwise, and components/TaskLedger.tsx with each task's final state, attempts, Warden Verdict and reasons.
    - Write components/ArtifactDownloads.tsx offering all.patch, the spec bundle, the report, events.ndjson and the Death_Certificate, each with size and sha256.
    - _Requirements: 38.1, 38.2, 38.4, 38.5, 38.6, 38.7, 38.8, 38.10_
  - [x] 15.6 Implement the History page and the Replay player main path
    - Write app/history/page.tsx and components/HistoryList.tsx listing only runs with an admin.publish event, with failed, partial and cancelled runs at the same weight as successful ones and no "best of" filter.
    - Write app/replay/[runId]/page.tsx and components/ReplayPlayer.tsx fetching stored events from GET /api/runs/{runId}/events with from and to as JSON and rendering exactly those events in seq order, with a visible gap at every missing seq, a persistent "Replay" banner and no run action buttons.
    - Make History, Replay and a stored Reliquary load with no live Skeleton and no Kiro access.
    - _Requirements: 33.1, 33.2, 33.3, 33.5, 33.6, 33.7, 33.11_
  - [x]* 15.7 Write property test for Real replays
    - **Property 18: Real replays (P18)**
    - **Validates: Requirements 33.1, 33.2, 33.6**
    - Verify with fast-check in test/props/real-replays.test.ts that Replay renders stored events strictly in seq order without mutations, displays visual gaps for missing seq numbers, and loads with zero live skeleton processes and zero Kiro credentials.

- [x] 16. Checkpoint - one real recorded run end to end, replayable. Run npm run test:props, npm run test:golden, and npm run test:e2e, ask the user if questions arise.

- [x] 17. [Teammate — Pure Code & Fixture Tests] Calibration support for the E11 defaults
  - [x] 17.1 Implement Admin settings storage for E11 defaults and audit tracking
    - Implement SettingsStore in lib/admin/settings-store.ts initializing E11 starting values including Warden rejection rounds, prompt wall-clock cap, run wall-clock cap, silent-Skeleton limit, approval wait, and queue idle limit
    - Enforce required settings validation refusing run startup if any required setting lacks a value
    - Record audit trail entries for all setting changes capturing timestamp, actor identity, and before and after values
    - Track recorded run completion count from EventStore and toggle recalibrationRequired flag when three recorded runs conclude
    - _Requirements: 30.1, 30.2, 30.3, 30.18, 30.20_
  - [x] 17.2 Implement calibration summary script for recorded runs
    - Query EventStore in scripts/calibrate-e11.ts to aggregate execution metrics across the first three completed recorded runs
    - Compute empirical distributions for observed Warden rejection rounds per task, prompt durations, run wall-clock durations excluding Pact waits, approval response wait times, and silence durations
    - Generate calibrated parameter proposals formatted as JSON and Markdown comparison against initial defaults with event ID citations
    - Provide CLI flags to commit updated calibrated values into SettingsStore with an audit entry
    - _Requirements: 30.20_
  - [x] 17.3 Write unit and integration tests for E11 calibration analysis and settings storage
    - Test SettingsStore initialization, missing required setting rejection, and audit log generation in test/admin/calibrate-e11.test.ts
    - Test scripts/calibrate-e11.ts across fixture runs verifying extraction of rejection rounds, duration calculations excluding Pact wait times, and proposed setting adjustments
    - Verify recalibrationRequired flag toggles to true upon the third recorded run conclusion
    - _Requirements: 30.1, 30.2, 30.3, 30.18, 30.20_

- [ ] 18. [Owner — Kiro CLI + Docker Sandbox Live Runs] Checkpoint - Three recorded runs and calibrated settings. Run npm run test:props and npm run test:golden, ask the user if questions arise.

- [ ] 19. [Teammate — Pure Code, Local Python 3 AST & Property Tests] Grimoire Python: M1 rules, Python gate, CPython oracle, Grimoire bundle and deterministic output
  - [x] 19.1 Implement M1 Python 2 to 3 rewrite rules and AST transform engine
    - Implement AST transforms and token rewrites in lib/rules/m1-python.ts for print statements, except clauses, unicode conversions, and dictionary iterator methods citing rule M1
    - Detect unhandled Python 2 residue constructs including exec, <>, backticks, ur prefixes, octals, L suffixes, tuple params, and raise E, msg, recording unknown with reason py2_residue
    - Implement edit range splicing in lib/rules/m1-python.ts skipping overlapping edits with reason edit_conflict while preserving BOM and line endings
    - Validate input UTF-8 encoding and verify repository declared Python version compatibility, halting on Python 2 only declarations
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13, 6.14, 6.16, 6.17, 6.18, 6.19_
  - [x] 19.2 Implement Grimoire Python syntax gate and Candidate verification
    - Implement Python gate evaluator in lib/grimoire/python-gate.ts measuring syntax error count and py2 residue count before and after edits
    - Reject M1 edits that increase parse errors or fail to decrease residue, recording unknown with gate_errors_rose, gate_residue_not_reduced, or parse_timeout
    - Assign m1-clean label when residue is zero and m1-partial otherwise, marking patch steps reverted when all edits are rejected
    - Verify Builder Candidates against Integration_Head ensuring Python error and residue counts do not increase, emit gate.result event, and return failure feedback to Builder
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.10, 9.11, 9.13_
  - [ ] 19.3 Implement CPython oracle test harness for verified Python outputs
    - Create Python oracle script in scripts/test-oracle.py invoking ast.parse with feature_version=(3, 13) to validate clean Python modernizations
    - Implement Jest test in test/oracle/cpython-oracle.test.ts running the oracle script as npm run test:oracle against golden outputs
    - Assert zero SyntaxError exceptions on all files marked m1-clean while confirming SyntaxError detection on unmigrated Python 2 syntax
    - _Requirements: 9.3, 10.7_
  - [ ] 19.4 Implement Grimoire bundle generator and deterministic output serializer
    - Implement template-only bundle writer in lib/grimoire/bundle.ts generating requirements.md, design.md, and tasks.md with mandatory M1 to M6 citations and mapping rows
    - Enforce 1:1 mapping between patch tasks and patch steps, checking tasks only when steps are unreverted and appending Outcome revert reasons
    - Append Outcome summary section to design.md with task status counts and m1-clean or m1-partial file labels
    - Derive deterministic engineVersion from rule engine source hashes and exclude timestamps, GitHub metadata, and model text from generated bundles
    - Extend scripts/fixtures/bake.ts from 5.10 to write each fixture's bundle to .kiro/specs/resurrection/<owner>-<repo>/ and the remaining golden files listed in design R3-12 under test/golden/<owner>-<repo>/
    - _Requirements: 6.1, 6.2, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11_
  - [ ]* 19.5 Write property test for M1 idempotence
    - **Property 2: M1 idempotence (P2)**
    - Implement fast-check property test in test/props/m1-idempotence.test.ts verifying applyM1(applyM1(f)) = applyM1(f) across generated Python files
    - **Validates: Requirements 6.15**
  - [ ]* 19.6 Write property test for Syntax gate
    - **Property 4: Syntax gate (P4)**
    - Implement fast-check property test in test/props/syntax-gate.test.ts verifying parses(f, mode(f)) holds for all modified JS/TS files or the failing step is marked reverted
    - **Validates: Requirements 9.5, 9.7, 9.8**
  - [ ]* 19.7 Write property test for Mapping rows
    - **Property 5: Mapping rows (P5)**
    - Implement fast-check property test in test/props/mapping-rows.test.ts verifying every row in design output cites a valid rule ID from M1 to M6
    - **Validates: Requirements 6.2**
  - [ ]* 19.8 Write property test for Tasks equal steps
    - **Property 7: Tasks equal steps (P7)**
    - Implement fast-check property test in test/props/tasks-equal-steps.test.ts verifying bijection T = S between patch tasks and patch steps, with completion tracking non-reverted state
    - **Validates: Requirements 10.4, 10.5**
  - [ ]* 19.9 Write property test for Monotone Python gate
    - **Property 8: Monotone Python gate (P8)**
    - Implement fast-check property test in test/props/python-gate.test.ts verifying parse error count is non-increasing and residue strictly falls for accepted edits
    - **Validates: Requirements 9.1, 9.3**
  - [ ]* 19.10 Write property test for Deterministic Grimoire output
    - **Property 9: Deterministic Grimoire output (P9)**
    - Implement fast-check property test in test/props/deterministic-output.test.ts verifying byte-identical Grimoire bundle and signal artifacts across identical inputs and frozen registry responses
    - **Validates: Requirements 10.8, 10.10**

- [ ] 20. [Teammate — Code & Mocked/Worktree Tests; Owner — Live Multi-Skeleton Sandbox Verification] Bonesetter, parallel Soul-stitchers and the headless fallback
  - [x] 20.1 Implement Bonesetter agent template and lifecycle manager
    - Create committed Bonesetter agent template in lib/agents/templates/bonesetter.md with read-workspace preset and allow rules restricted to package manifests and lockfiles
    - Enforce agent tool restrictions denying shell, web, subagent, and configure fs_read and fs_write denials for .env, credentials, .git, and .kiro
    - Implement Bonesetter initialization in lib/agents/bonesetter.ts configuring pinned Claude Sonnet 5.5 model and bundling task Grimoire guidance into steering resources
    - Wire typed tool interfaces for read, write, sandbox_exec, sandbox_log, report_task_result, ask, report_blocker, and ack_message
    - _Requirements: 14.1, 14.2, 14.5, 14.9, 14.10, 14.11, 14.12, 14.13, 14.14, 14.15, 14.18_
  - [x] 20.2 Implement Headless Fallback execution channel and stream-json parser
    - Implement HeadlessFallbackChannel in lib/acp/headless-fallback.ts spawning kiro-cli chat --v3 --no-interactive with stream-json output and trusted gateway tools
    - Implement stream logger and JSON event parser in lib/acp/stream-parser.ts reading stdout stream to disk and verifying active model reporting per probe P14
    - Map process exit codes with 0 to success, 1 to failure, 3 to gateway_missing, and 4 to missing agent with output discard
    - Handle approval interrupts with approval IDs and session resumption via --resume-id, outright refusing needs_approval if S2 resume failed, and auto-denying ask calls
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 17.11, 17.12, 45.15, 45.18_
  - [ ] 20.3 Implement parallel Soul-stitcher dispatch and concurrency scheduling
    - Extend Scheduler in lib/scheduler/parallel-scheduler.ts to manage concurrent Soul-stitcher slots bounded by parallel cap, global cap, and backend runningMax
    - Dispatch ready tasks in priority order from approved tasks.md, provisioning isolated branches and worktrees via lib/git/git-service.ts
    - Assign Claude Opus 5.5 to tasks marked hard: yes and Claude Sonnet 5.5 to standard tasks
    - Queue completed candidate branches for serialized Warden review while active parallel Soul-stitchers continue in other worktrees
    - _Requirements: 23.5, 23.6, 23.14_
  - [ ] 20.4 Write integration tests for Bonesetter, Headless Fallback, and parallel scheduling
    - Test Bonesetter worktree operations in test/scheduler/parallel-bonesetter.test.ts verifying write permissions on lockfiles and denial on repository code
    - Test Headless Fallback execution in test/scheduler/parallel-bonesetter.test.ts asserting stream-json parsing, exit code mapping, and approval resume flow
    - Verify parallel Scheduler dispatch enforces slot concurrency limits, priority order, and independent git worktree isolation
    - _Requirements: 14.5, 17.8, 23.5, 23.14_

- [ ] 21. [Teammate — Pure Code, API Routes & Property Tests] Messaging, human-in-the-loop tiers, hard blocks, fork push and their mutating API routes for messages, approvals, asks, skeleton actions and run control
  - [ ] 21.1 Implement two-way messaging service and Skeleton mailbox management
    - Implement MessageService in lib/messaging/message-service.ts storing message events in EventStore and maintaining per-skeleton mailboxes
    - Handle delivery strategies by queueing for _session/steer or post-command prompt injection, or immediate turn cancellation for Interrupt now
    - Track message states from Sent to Delivered and Acknowledged, and duplicate user-to-skeleton messages to the Necromancer channel with cc: necromancer
    - Validate role-specific intents, rejecting unauthorized actions on Wardens or Scribes, and issue nudges when skeletons exceed silence limits
    - _Requirements: 27.1, 27.2, 27.3, 27.5, 27.6, 27.7, 27.8, 27.9, 27.10, 27.11, 27.12, 27.16_
  - [ ] 21.2 Implement human-in-the-loop tier orchestration and AskManager
    - Implement AskManager in lib/hitl/ask-manager.ts enforcing Tier 1 user approvals and emitting Tier 2 necromancer.decision events with explicit evidence refs
    - Route runtime asks, task splits, and Pact revisions to active Planner sessions during Legion phase
    - Render approval cards with command text, cwd, risk class, requesting skeleton, and expiry timestamp
    - Manage ask deadlines enforcing design-specified timeout defaults including denying commands and stopping on exceeded budgets
    - _Requirements: 28.1, 28.2, 28.4, 28.5, 28.6, 28.7, 28.8, 28.9, 28.10_
  - [ ] 21.3 Implement code-enforced hard blocks and GitService fork push
    - Enforce unbypassable Tier 3 hard block checks in lib/policy/hard-blocks.ts rejecting forbidden command argvs, sudo, container sockets, and unauthorized budget increases
    - Validate candidate diffs in lib/policy/hard-blocks.ts rejecting any modifications inside .kiro/ or .git/ directories
    - Implement pushToFork(runId) in lib/git/git-service.ts holding exclusive write tokens and validating fork ownership, done run phase, and invite push flag
    - Restrict fork push refspec exclusively to new branch graveyard/<runId>, ensuring no push or comment ever targets the source repository, and emit push.requested and push.result
    - _Requirements: 27.13, 27.14, 27.15, 29.1, 29.2, 29.3, 29.5, 29.6, 29.7, 29.8, 29.9, 29.10, 29.11, 29.12, 29.13, 29.14_
  - [ ] 21.4 Implement mutating Next.js API route handlers for run operations
    - Implement app/api/runs/[runId]/messages/route.ts validating caller run ownership and delivering structured messages to MessageService
    - Implement app/api/runs/[runId]/approvals/[approvalId]/route.ts and app/api/runs/[runId]/asks/[askId]/route.ts handling user decisions and ask resolutions
    - Implement app/api/runs/[runId]/skeletons/[skeletonId]/actions/route.ts and app/api/runs/[runId]/control/route.ts executing skeleton management and run pausing and stopping
    - Implement app/api/runs/[runId]/push-fork/route.ts asking push_confirm and invoking GitService pushToFork upon confirmation
    - _Requirements: 27.1, 27.8, 27.9, 28.1, 28.9, 29.1, 29.5, 31.13_
  - [ ]* 21.5 Write property test for No upstream writes
    - **Property 15: No upstream writes (P15)**
    - Implement fast-check property test in test/props/no-upstream-writes.test.ts verifying all Git write operations target only verified owner forks on graveyard/<runId> branches with push flag enabled, never targeting source repository
    - **Validates: Requirements 29.1, 29.2, 29.3, 29.7**

- [ ] 22. [Teammate — Pure Code, Admin API & Property Tests] Admission, invite codes, FIFO queue, budgets and caps
  - [ ] 22.1 Implement Invite Code generator, storage, and authentication service
    - Implement InviteCodeService in lib/admission/invite-code.ts generating hashed invite codes with expiration timestamps, run quotas, and default push: false
    - Restrict invite code creation to signed-in Admin sessions, displaying full plaintext code strictly once upon creation
    - Track and enforce IP-based rate limiting on invite code verification attempts to prevent brute force abuse
    - Validate invite codes against hash storage on run submission, rejecting expired or exhausted tokens
    - _Requirements: 29.4, 31.1, 31.2, 31.3, 31.4, 31.5_
  - [ ] 22.2 Implement FIFO admission queue, capacity management, and rate limit backoff
    - Implement FifoQueue in lib/admission/fifo-queue.ts managing run queuing, depth limits, queue idle timeouts, and emitting run.queued and run.queue_position
    - Implement AdmissionController in lib/admission/admission-controller.ts checking required settings, repo size cap, and backend capacity for dev and production
    - Retain runs queued with reason capacity when cloud backend capacity reports zero, and enforce single Skeleton fallback if probe P8 or spike S4 shows capacity limits
    - Handle Kiro rate limit backoff and pause queue, and halt admissions without retries while preserving queue and alerting Owner on ACP auth failure
    - _Requirements: 31.6, 31.7, 31.8, 31.9, 31.10, 31.11, 31.14, 31.15, 31.16, 41.11, 41.13, 41.15, 45.8_
  - [ ] 22.3 Implement BudgetGovernor runtime metering and multi-dimensional cap enforcement
    - Implement BudgetGovernor in lib/governor/budget-governor.ts tracking prompt durations, skeleton prompt counts, turn tool calls, and run wall-clock excluding Pact waits
    - Emit budget.warning at 80 percent threshold and budget.exceeded at 100 percent cap on any dimension, prompting exceed_budget while letting current commands finish
    - Enforce credit limits per run and day if probe P5 reveals credit reporting, or enforce wall-clock and tool call caps only without estimating credits
    - Handle context usage thresholds by steering skeleton wrap-up before cancellation, enforce Code_Ceiling boundaries, and end runs budget_stopped upon credit exhaustion
    - _Requirements: 30.1, 30.2, 30.3, 30.4, 30.5, 30.6, 30.7, 30.8, 30.9, 30.10, 30.11, 30.12, 30.13, 30.14, 30.15, 30.16, 30.17, 30.18, 30.19, 30.21, 45.16_
  - [ ]* 22.4 Write property test for Caps stop new work
    - **Property 20: Caps stop new work (P20)**
    - Implement fast-check property test in test/props/caps-stop-new-work.test.ts verifying that after budget.exceeded is emitted on any capped dimension, no subsequent session/prompt or sandbox_exec is dispatched unless an explicit grant raises the cap within the code ceiling
    - **Validates: Requirements 30.7**
  - [ ] 22.5 Implement the Admin session, the admin service and the /api/admin routes
    - Implement lib/admin/admin-session.ts with the sign-in method the Owner records for open decision V20; the admin secret stays in the Necromancer and out of the UI bundle, and every /api/admin route refuses a request without a valid Admin session.
    - Implement the app/api/admin/ routes for Invite_Codes (create, list, revoke), budget settings (an audit entry on every change), the queue (remove, move, cancel), publish, redact and hide for finished runs, and the pre-promotion audit sign-off record.
    - Implement lib/admin/kill-switch.ts with three levels: pause new runs (Admission stops admitting and keeps the queue), stop gracefully (running Skeletons end at their next tool boundary and worktrees are kept) and hard kill (affected runs end with outcome killed); each level reports how many runs it affects before it acts, and each action is recorded as an admin.kill event.
    - Append admin.redaction for every redaction and admin.publish only after the Admin has reviewed the run and applied any redaction; record a hide so that History and the Reliquary show "Removed by the owner".
    - _Requirements: 28.3, 30.18, 31.1, 31.14, 32.3, 33.4, 39.10, 39.11_

- [ ] 23. [Teammate — Code & Mocked Recovery Tests; Owner — Live Container OOM/TTL Verification] Scribe report check and failure handling
  - [ ] 23.1 Implement Scribe agent template, lifecycle orchestration, and report drafting
    - Create committed Scribe agent template in lib/agents/templates/scribe.md configuring Claude Haiku 5.5, edit-workspace preset, and write tool restricted to report/**
    - Implement ScribeService in lib/scribe/scribe-service.ts raising the Scribe upon final_check completion
    - Render deterministic Findings section from RunStore event records using structured templates without model generation
    - Prompt Scribe to draft Scribe's reading narrative requiring strict evidence citations for all numeric and status assertions
    - _Requirements: 14.1, 14.2, 14.8, 14.9, 14.10, 14.11, 14.12, 14.13, 14.15, 14.18, 26.4, 26.5_
  - [ ] 23.2 Implement Report_Check evidence verification, retry, and report finalization
    - Implement ReportCheck in lib/scribe/report-check.ts verifying all numerals and status claims against stored cmd:, file:, gh:, or ev: evidence markers
    - Re-raise Scribe once with specific unbacked claims upon initial verification failure
    - Drop Scribe's reading and substitute verified evidence fallback notice if verification fails on second attempt
    - Emit report.checked and assign run outcome among resurrected, resurrected_build_only, partial, or not_resurrected displaying baseline and new installation errors side by side
    - _Requirements: 26.6, 26.7, 26.8, 26.9, 26.16, 26.17, 41.1, 41.2, 41.3, 41.25_
  - [ ] 23.3 Implement Skeleton supervisor failure handling and process recovery
    - Implement failure recovery handlers in lib/supervisor/failure-recovery.ts verifying active model against role tier and checking MCP gateway connectivity, failing with model_mismatch or gateway_missing before sending prompts
    - Handle kiro-cli crashes and broken pipes by preserving worktrees and logs, emitting Recovering state, and respawning once via session/load without prompt re-transmission
    - Continue dispatching open Pact tasks in lib/supervisor/failure-recovery.ts when a task is skipped after reaching maximum Warden rejection rounds
    - Enforce security containment by quarantining worktrees on secret detection or symlink escapes, and log anomalies on PermissionBroker watchdog timeouts
    - _Requirements: 41.4, 41.5, 41.6, 41.12, 41.19, 41.20, 41.21, 41.22, 41.23, 41.24_
  - [ ] 23.4 Implement boot reconciliation, Box recovery, and external failure handlers
    - Implement boot reconciliation in lib/recovery/boot-reconciliation.ts reading RunStore, reaping orphaned kiro-cli processes by pidfile, and destroying orphan boxes
    - Emit system.worker_restart, pause run clocks during recovery, and fail runs whose containers are lost with outcome error while preserving all collected evidence
    - Monitor ExecutionBackend events for container OOM, exit, or TTL expiration, recreating box once, rerunning failed command, and tagging oomKilled or timedOut
    - Enforce cooldowns on GitHub 403 and 429 rate limits and transition runs to budget_stopped when Kiro API credits are exhausted
    - _Requirements: 41.7, 41.8, 41.9, 41.10, 41.16, 41.17, 41.18_
  - [ ] 23.5 Write unit and integration tests for Report_Check verification and failure recovery
    - Test Report_Check in test/scribe/report-check.test.ts verifying marker resolution for numerals and status keywords, single retry behavior, and section dropping
    - Test Skeleton supervisor error paths in test/recovery/failure-recovery.test.ts verifying model_mismatch, gateway_missing, silence nudges, and crash recovery
    - Test boot reconciliation and box recovery in test/recovery/failure-recovery.test.ts verifying pidfile process cleanup, container recreation, and rate limit handling
    - _Requirements: 26.6, 26.7, 26.8, 41.5, 41.7, 41.17, 41.20, 41.21, 41.24_

- [ ] 24. [Teammate — Pure Frontend / UI States] UI completion: remaining states on the slice screens, task graph, Built with Kiro page and Admin page
  - [ ] 24.1 Add the Legion attention, reconnect and recovery states
    - Extend components/LegionDashboard.tsx and components/RunHeader.tsx from 15.4: while an item needs the user, show the inbox badge, fill the "You" slot and put the state in the browser tab title.
    - While the SSE connection is down, show "Reconnecting... showing events up to #<seq>" and resume from Last-Event-ID.
    - While the Necromancer recovers after a restart, show the recovering state on the affected cards; when a crashed Skeleton is respawned, show "Recovering" followed by "Resumed the same session" or "Restarted from its last commit".
    - _Requirements: 37.4, 37.5, 37.6, 41.6_
  - [ ] 24.2 Add the Skeleton card controls, the silent state and the run-end states
    - Extend components/SkeletonCard.tsx from 15.4 with Send instruction, Interrupt, Re-raise and Lay to rest on every Builder card, and Add review focus instead of Send instruction on the Warden card; a disabled button that receives focus states why it is disabled.
    - When the user chooses "Interrupt now" delivery, warn that the running command's output will be lost; when the user chooses Lay to rest, open components/LayToRestModal.tsx with the choices "Keep its commits" and "Discard its work".
    - Show "Silent for mm:ss" on a card whose Skeleton produced no tool call and no log line for the silent-Skeleton limit.
    - On a run-level error, show a plain message with links to the kept evidence; when some tasks merged and others failed or were abandoned, show the partial state.
    - _Requirements: 27.4, 37.8, 37.9, 37.11, 37.12, 37.13, 37.17_
  - [ ] 24.3 Implement synchronized task graph visualization and accessible task table
    - Write components/TaskGraph.tsx rendering an interactive directed acyclic task graph showing task dependencies, states, attempt numbers, and Warden verdicts
    - Write components/TaskTable.tsx providing a synchronized keyboard-navigable table view carrying identical task state, dependency, and attempt data
    - Implement accessible toggle between graph and table view, preserving selection and state synchronization across live run updates
    - _Requirements: 37.16_
  - [ ] 24.4 Add the remaining Gate states
    - Extend components/GateView.tsx and components/HealthBadge.tsx from 15.1: in production mode the badge has no "waking up" state; while Admission is stopped by an authentication failure, the badge shows "Live runs: unavailable".
    - Show a distinct message for each of a wrong, expired, revoked and used-up Invite_Code.
    - While live runs are paused or unavailable, keep the autopsy working and explain why Exhume is disabled; when GitHub rate-limits the autopsy, show the GitHub reset time.
    - _Requirements: 34.2, 34.7, 34.8, 34.9, 41.14_
  - [ ] 24.5 Add the Tombstone autopsy result and error states
    - Extend components/TombstoneView.tsx from 15.2: for status alive, show "still breathing" with the reasons checked and keep the full autopsy visible.
    - Show a not-found-or-private message for REPO_NOT_FOUND, the exceeded size limit for TOO_LARGE, the files the Grimoire looked for for LANGUAGE_UNKNOWN, and the GitHub reset time for RATE_LIMITED.
    - When some manifests cannot be read, show a partial state that lists the unreadable manifests.
    - _Requirements: 4.6, 35.2, 35.3, 35.4, 35.5, 35.6, 35.7_
  - [ ] 24.6 Add the Exhume visitor, outcome and failure states
    - Extend components/ExhumeView.tsx from 15.2: while the visitor has no Invite_Code, keep the autopsy and the Replays of Recorded_Runs available, disable the Exhume button with the reason and offer a link to a Replay.
    - Extend components/DeathCertificateView.tsx: when install, build and tests all pass, state that the repository installs, builds and passes its tests today and offer "Plan modernization anyway" and "Stop here"; when install fails, show it as the primary finding with the build and test rows marked Not run; when no tests are found, show "No tests found" in the test row with the rule that decided it.
    - Extend components/CommandRow.tsx: on an Exhume error, show a plain-English message and View output; when the Exhumer times out, keep the completed rows and mark the rest "Not run: time limit"; show oomKilled or timedOut on a command row that ended that way.
    - _Requirements: 31.12, 35.10, 35.14, 35.15, 35.16, 35.17, 35.18, 41.18_
  - [ ] 24.7 Add the Pact screen editing, revision, parked and failure states
    - Extend components/PactEditor.tsx from 15.3: when the Planner finds nothing to change, show the reason and a Stop button; when the Pact fails to parse or the Planner fails, show the validation error in plain language with "Try again" and "Stop".
    - Reject an edit that creates a dependency cycle and name the cycle; when the user turns a task off, flag every task that depends on it.
    - While the Planner revises the Pact, lock edits and show the diff between versions in components/PactDiff.tsx when the revision arrives; while the run is parked, offer "Resume" and state that resuming clones the repository again.
    - Extend components/BudgetSettings.tsx: when probe P5 shows no credit field in turn_completion, state "Credits are not reported by the CLI; the cap is minutes and tool calls".
    - _Requirements: 36.2, 36.3, 36.5, 36.6, 36.9, 36.10, 36.12_
  - [ ] 24.8 Add the Reliquary partial, empty, missing, hidden, push and report-check states
    - Extend components/ReliquaryView.tsx from 15.5: for outcome partial, list what works and what does not from the before and after table.
    - When no task merged, state that there is no diff and offer only the Death_Certificate and the report; when an artifact is missing, show "This file could not be built. The event log is still available."; when the Admin has hidden the run, show "Removed by the owner".
    - Where the Invite_Code's push flag is on, show the push target Fork and the branch graveyard/<runId> and state that the Source_Repository is not touched.
    - When the Scribe's run report fails the Report_Check, drop the unverified reading and state that the model reading failed verification.
    - _Requirements: 38.3, 38.11, 38.12, 38.13, 38.14, 38.15_
  - [ ] 24.9 Add the remaining History and Replay states
    - Extend components/HistoryList.tsx from 15.6: a loading state, an error state with a plain message on a load error, the empty state "No recorded runs have been published yet", and "Removed by the owner" for hidden runs.
    - Show on every History row the repository, short base sha, date, outcome, wall time, roles used, before and after build status, recorded-on mode, engine version and the label "Recorded live run".
    - Extend components/ReplayPlayer.tsx: show replay time and original time and label every shortened wait; show "Redacted by the owner" at each admin.redaction point; at the last event, show the ended state and offer the Reliquary; for a killed run, label the last stored event as the point where the run was stopped; show an error state when the event log cannot be read.
    - _Requirements: 33.8, 33.9, 33.10, 39.1, 39.2, 39.3, 39.4, 39.5, 39.6, 39.14_
  - [ ] 24.10 Implement the Built with Kiro page and the Admin page states
    - Write app/built-with-kiro/page.tsx and components/BuiltWithKiroView.tsx displaying evidence loaded from kiro-evidence.json and GET /api/history?fields=kiro, with "None found" in any section whose source file is missing.
    - Write app/admin/page.tsx and components/AdminDashboard.tsx: only the sign-in state while no Admin is signed in, the empty state when no Invite_Code exists, and publish, redact and hide for finished runs; a run reaches the History_Page only through the Admin's publish action, which is enabled only after the Admin has reviewed the run and applied any redaction; hide marks the run "Removed by the owner".
    - Write components/KillSwitchModal.tsx with the three kill levels (pause new runs; stop gracefully, where running Skeletons end at their next tool boundary and worktrees are kept; hard kill), each behind a typed confirmation that states how many runs the level affects.
    - Block the production-mode switch until a signed pre-promotion audit record exists (Requirement 44.14); when probe P15 shows that _kiro/account/getUsage is not advertised, direct the Owner to the Kiro portal for the credit balance.
    - _Requirements: 28.3, 33.4, 33.10, 39.7, 39.8, 39.9, 39.10, 39.11, 39.12, 39.13, 44.14, 45.11_

- [ ] 25. [Teammate — Pure Code, A11y & Offline Playwright axe-core E2E] Honest metrics registry, accessibility and English copy
  - [ ] 25.1 Implement Metric Registry and honest value formatters
    - Write lib/metrics/registry.ts and lib/metrics/formatters.ts mapping all displayed numerals and metrics to R4-13 Metric_Registry rows M1 to M31, computing values strictly from authoritative recorded sources
    - Render missing sources as not available with reason, credits as not reported without CLI reporting, test counts as Counts not available without runner reports, and npm deprecation warning counts as not available while Spike S3 has not recorded the format
    - Compute all durations from the Necromancer clock, derive install, build, and test command statuses strictly from exitCode, timedOut, and oomKilled flags, mark unexecuted steps as not run, and display GitHub numbers with asOf date and Kiro CLI version from recorded version command
    - Suppress all scores, health percentages, confidence percentages, time estimates on queue positions, and duration estimates when fewer than 3 comparable runs exist (No estimate yet), formatting Runs like this took between X and Y using shortest and longest recorded wall times
    - _Requirements: 40.1, 40.2, 40.3, 40.4, 40.5, 40.6, 40.7, 40.8, 40.10, 40.11, 40.12, 40.13, 40.14, 40.15, 41.18_
  - [ ]* 25.2 Write property test for Metric provenance (P14)
    - **Property 14: Metric provenance (P14)**
    - **Validates: Requirements 30.10, 30.11, 40.1, 40.2**
    - Implement property-based test with fast-check in test/props/metric-provenance.test.ts generating arbitrary runs, missing fields, and command results to assert that every displayed number maps to an R4-13 source or renders not available or not reported, with zero estimated numerals
    - _Requirements: 30.10, 30.11, 40.1, 40.2_
  - [ ] 25.3 Implement English copy rules, forbidden claims linter, and gothic glossing
    - Write components/GlossedTerm.tsx using lib/copy/glossary.ts from 3.3 to show plain-English glosses upon first appearance of gothic terms (Necromancer, Skeleton, Grimoire, Pact, Death_Certificate, Legion, Reliquary, Lay_to_rest)
    - Enforce English-only text across all user-facing UI components, restricting the gothic voice strictly to headings and empty states, and ensuring error messages provide plain words stating what action to take next
    - Enforce exact Kiro role description Skeleton sessions run on Kiro CLI. and Gate footer statement Git-Graveyard is an independent project., and implement lib/copy/claims-linter.ts asserting absence of forbidden claims (X% faster, hours saved, production ready, safe, understood, or Kiro product)
    - _Requirements: 40.9, 47.1, 47.2, 47.3, 47.4, 47.5, 47.6_
  - [ ] 25.4 Implement UI accessibility landmarks, keyboard navigation, and focus management
    - Add header, main, and complementary landmarks to app layout with skip link to the Needs you action slot in components/a11y/SkipLink.tsx
    - Ensure Tab key navigation reaches every action, implement roving-tabindex keyboard list for task graph nodes in lib/a11y/roving-tabindex.ts, and provide a settings control in lib/a11y/shortcuts.ts allowing users to disable every keyboard shortcut
    - Preserve keyboard focus on active elements across live SSE events, and write components/a11y/FocusTrap.tsx trapping focus in modal dialogs and returning focus to the opener element upon dismissal
    - _Requirements: 46.2, 46.3, 46.4, 46.5, 46.14_
  - [ ] 25.5 Implement live announcements, reduced motion, contrast, and element semantics
    - Write components/a11y/AriaAnnouncer.tsx providing polite live region for non-fatal state changes and assertive region exclusively for fatal run errors or kill actions, keeping counters and timers outside live regions
    - Configure Skeleton card log tails with role="log", aria-live="off" by default, an announcement toggle control, and data-rule and data-file attributes on console log DOM nodes
    - Write styles/accessibility.css disabling fog drift, candle flicker, graph glow, and scroll animations under prefers-reduced-motion, with Replay stepping through graph changes without animation
    - Enforce WCAG AA contrast with body text contrast of at least 4.5:1 on #0a0a0c using accent purple only for borders and icons, convey states with icon and text in addition to color, show advance warnings for expiring timed controls, assign accessible names to Skeleton cards, and provide semantic pre element fallback for diffs
    - _Requirements: 46.6, 46.7, 46.8, 46.9, 46.10, 46.11, 46.12, 46.13, 46.15, 46.16, 46.17_
  - [ ] 25.6 Implement automated accessibility test suite with axe-core
    - Write Playwright test suite in test/e2e/accessibility.spec.ts scanning Gate, Tombstone, Pact, Legion, Reliquary, History, Replay, Built with Kiro, and Admin pages
    - Execute automated axe-core accessibility audit using npm run test:e2e asserting zero violations of impact serious or critical across all states
    - _Requirements: 46.1_

- [ ] 26. [Teammate — Pure Code, Build Script & UI Component] Built with Kiro evidence builder and Open in Kiro handoff
  - [ ] 26.1 Implement build-time Kiro evidence builder script
    - Write scripts/evidence/build-evidence.ts and package.json script evidence:build generating kiro-evidence.json adhering to the verified build evidence schema
    - Scan repository and index only verified existing files: specs (.kiro/specs/**), steering files with their inclusion mode (.kiro/steering/**), hooks with their triggers (.kiro/hooks/*.json), role agent templates (lib/agents/templates/**), and spec-to-task-to-commit links derived from git log
    - Assert that every referenced file path exists on disk before writing kiro-evidence.json
    - _Requirements: 48.5_
  - [ ] 26.2 Implement CI verification of Kiro evidence integrity
    - Write test/ci/evidence-integrity.test.ts verifying that every file path listed in kiro-evidence.json exists in the repository
    - Fail CI execution if kiro-evidence.json contains non-existent paths, stale commit links, or invalid schema formatting
    - _Requirements: 48.6_
  - [ ] 26.3 Implement Built with Kiro evidence runtime data loader and page integration
    - Write lib/evidence/evidence-service.ts loading kiro-evidence.json and fetching GET /api/history?fields=kiro to feed app/built-with-kiro/page.tsx
    - Render build-time evidence in components/BuiltWithKiroEvidence.tsx showing specs, steering files, hooks, and committed role agent templates with configured tool permissions from lib/agents/templates/
    - Extract from the three most recent published runs each Skeleton's role, agent name, model ID, kiro-cli version, session ID, and timestamp from run.started and skeleton.raised events
    - Present architectural boundaries identifying the Grimoire autopsy path under the section What does not use Kiro
    - _Requirements: 48.7, 48.8, 48.9, 48.10_
  - [ ] 26.4 Implement Open in Kiro handoff instructions in Reliquary
    - Write lib/artifacts/kiro-handoff.ts and components/OpenInKiroHandoff.tsx embedded in components/ReliquaryView.tsx displaying handoff instructions for the run bundle
    - Instruct the user to execute git apply -p1 all.patch on a clone at the pinned sha, followed by copying spec/ to .kiro/specs/resurrection/<owner>-<repo>/
    - Provide fallback copy target directory .kiro/specs/<owner>-<repo>/ if unknown U14 shows that Kiro does not list nested spec folders
    - Format verification commands and Kiro CLI invocation steps for resuming development locally
    - _Requirements: 38.9, 48.11, 48.12_

- [ ] 27. [Teammate — Offline Verification (test:props, test:golden, test:e2e)] Checkpoint - Full judge journey verified across all v1 screens, honest metrics, and Kiro evidence. Run npm run test:props, npm run test:golden, and npm run test:e2e, ask the user if questions arise.

- [ ] 28. [Owner — Docker Cloud Sandbox & Host Daemon; Teammate — Pure Sync Validator Logic (28.2)] DockerCloudSandboxBackend (topology P-B) and always-on host configuration
  - [ ] 28.1 Implement DockerCloudSandboxBackend core under Topology P-B
    - Write lib/execution/docker-cloud-sandbox-backend.ts conforming to ExecutionBackend interface selected when EXECUTION_BACKEND=docker-cloud-sandbox in lib/execution/backend-factory.ts
    - Enforce Topology P-B where kiro-cli runs on the production host and Necromancer operates outside every cloud sandbox, enforcing Topology P-B whenever probe P10 or P11 lacks a recorded pass
    - Accept commands strictly as argv arrays rejecting shell command strings and user ID 0
    - If probe P16 shows that the production SDK does not separate stderr, report separateStderr: false and log output as a single merged stream
    - _Requirements: 43.1, 43.2, 43.7, 43.12, 43.13, 43.19, 43.20_
  - [ ] 28.2 Implement Topology P-B workspace file synchronization and security sanitization
    - Write lib/execution/sandbox-sync.ts maintaining the host worktree as authoritative source of truth for model edits using syncIn and syncOut
    - Implement security validation in lib/execution/sync-validator.ts rejecting absolute paths, .. segments, paths under .git/ or .kiro/, symlinks, and files exceeding the size limit during syncOut
    - Exclude build outputs including node_modules and dist during syncOut while including sources, manifests, and lock files
    - Reject Box specs carrying secret values, non-empty secrets or ports fields, or env vars matching secret denylist, configure default deny networking with hostname allowlist, and support Box re-attachment via get and label listing on restart with idempotency keys and sequenced output streaming
    - _Requirements: 43.3, 43.4, 43.5, 43.6, 43.8, 43.9, 43.14, 43.15, 43.16_
  - [ ] 28.3 Implement production cloud sandbox lifecycle, quotas, and host configuration
    - Write lib/execution/cloud-lifecycle.ts enforcing default lifetime TTL of 1 hour with a renewable hard cap of 24 hours for cloud sandboxes
    - Limit admitted production concurrency to at most 5 concurrent runs based on the 10-sandbox account quota
    - Prohibit creation of snapshots for any sandbox, and pull artifacts and logs from sandboxes upon run completion before destroying sandboxes
    - Write lib/execution/host-config.ts establishing always-on host configuration, environment variable validation, and daemon supervision outside cloud sandboxes
    - _Requirements: 43.17, 43.18, 43.21, 43.22_
  - [ ] 28.4 Write integration test suite for DockerCloudSandboxBackend
    - Test DockerCloudSandboxBackend operations in test/execution/docker-cloud-sandbox.test.ts: Topology P-B host kiro-cli execution, separateStderr reporting based on probe P16, and host worktree authority
    - Test syncOut security sanitization rejecting absolute paths, directory traversal, .git/ or .kiro/ writes, symlinks, and oversized files
    - Test exclusion of build outputs (node_modules, dist), sandbox snapshot rejection, TTL expiration enforcement, and 5-run concurrency quota limits
    - _Requirements: 43.14, 43.15, 43.18, 43.20, 43.21, 43.22_

- [ ] 29. [Teammate — Audit Schema & Gate Validator Code (29.1); Owner — Live G1/G3 Audit, XR-01..03 Sandbox Checks & Credential Rotation (29.2–29.4)] Promotion gate tooling and audits
  - [ ] 29.1 Implement Promotion Gate audit validation engine and schema
    - Write lib/audit/promotion-gate.ts and lib/audit/audit-schema.ts covering every audit block of wp-c C11 (CR, PI, IS, NE, PO, AD, LG, SN, PR, RP, RL, SC, KI) plus items XR-01, XR-02, and XR-03
    - Require every audit item to conclude as Pass or Accepted risk with Owner signature, requiring a written rationale recorded in the audit evidence if an item of severity B is accepted as a risk
    - Enforce that no production credential is created and no production URL is published before the pre-promotion audit passes
    - Block switching Necromancer to production mode in Admin page (app/admin/page.tsx) without a signed pre-promotion audit record, and track audit completion under memory task T8 as a prerequisite to production launch
    - _Requirements: 44.1, 44.2, 44.3, 44.4, 44.13, 44.14_
  - [ ] 29.2 Implement Security Access Audit runner and evidence recorder
    - Write scripts/audit/run-security-audit.ts executing the Security Access Audit twice: once before promotion (G1) and once after promotion (G3), with the second run executing items marked post
    - Save audit evidence in 01_evidence/audit-<date>/ with exactly one file per item ID in lib/audit/evidence-recorder.ts
    - Execute repository-going-public block RP by running the opensource-privacy-audit skill and attaching the skill report to the audit evidence
    - _Requirements: 44.5, 44.6, 44.7_
  - [ ] 29.3 Implement audit verification for extension items XR-01, XR-02, and XR-03
    - Write scripts/audit/verify-xr-items.ts and lib/audit/xr-verifier.ts evaluating extension items XR-01, XR-02, and XR-03
    - Verify item XR-01: verify that every Box of a finished run is destroyed and no residual state carries over to subsequent runs
    - Verify item XR-02: verify that the kill switch functions successfully at all three design levels (pause new runs, stop gracefully, hard kill)
    - Verify item XR-03: verify that any push to a non-fork repository and any write operation to the Source_Repository are refused
    - _Requirements: 44.10, 44.11, 44.12_
  - [ ] 29.4 Implement credential rotation verification and promotion gate test suite
    - Write scripts/audit/verify-credentials.ts verifying that all production credentials (Kiro key, Docker key, invite codes, GitHub tokens) are created fresh and differ from every development credential
    - Verify that development credentials (development Kiro key, Instabox key, dev invite codes, development GitHub tokens) are revoked upon promotion, and assert that post-promotion audit verifies the old values fail
    - Write test/audit/promotion-gate.test.ts testing both audit runs (G1 and G3), verifying that unsigned or incomplete audit records block production mode, and validating enforcement of Pass or signed Accepted risk
    - _Requirements: 44.8, 44.9, 44.14_

- [ ] 30. [Owner — Production Sandbox & Kiro CLI Verification] Checkpoint - Production promotion gate passed and live runs verified on production URL. Run npm run test:props, npm run test:golden, and npm run test:e2e, ask the user if questions arise.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": [
        "1.1"
      ]
    },
    {
      "id": 1,
      "tasks": [
        "1.2"
      ]
    },
    {
      "id": 2,
      "tasks": [
        "1.3"
      ]
    },
    {
      "id": 3,
      "tasks": [
        "1.4"
      ]
    },
    {
      "id": 4,
      "tasks": [
        "1.5"
      ]
    },
    {
      "id": 5,
      "tasks": [
        "1.6"
      ]
    },
    {
      "id": 6,
      "tasks": [
        "2"
      ]
    },
    {
      "id": 7,
      "tasks": [
        "3.1"
      ]
    },
    {
      "id": 8,
      "tasks": [
        "3.2",
        "3.3",
        "3.4",
        "4.1",
        "5.1"
      ]
    },
    {
      "id": 9,
      "tasks": [
        "3.5",
        "4.2",
        "5.9"
      ]
    },
    {
      "id": 10,
      "tasks": [
        "3.6",
        "4.3"
      ]
    },
    {
      "id": 11,
      "tasks": [
        "4.4",
        "6.1",
        "7.1",
        "8.1",
        "9.1",
        "9.3",
        "10.1",
        "10.3",
        "11.1",
        "11.2",
        "11.3"
      ]
    },
    {
      "id": 12,
      "tasks": [
        "4.5",
        "5.4",
        "5.5",
        "6.2",
        "6.3",
        "7.2",
        "9.2"
      ]
    },
    {
      "id": 13,
      "tasks": [
        "4.6",
        "5.2",
        "6.4",
        "6.6",
        "6.7",
        "7.3",
        "9.4"
      ]
    },
    {
      "id": 14,
      "tasks": [
        "4.7",
        "5.3",
        "5.6",
        "7.4"
      ]
    },
    {
      "id": 15,
      "tasks": [
        "4.8",
        "5.7",
        "5.8",
        "10.5"
      ]
    },
    {
      "id": 16,
      "tasks": [
        "5.10",
        "6.5",
        "8.2"
      ]
    },
    {
      "id": 17,
      "tasks": [
        "8.3",
        "9.5",
        "9.6",
        "10.2",
        "10.4",
        "10.7",
        "11.4",
        "15.1"
      ]
    },
    {
      "id": 18,
      "tasks": [
        "8.4",
        "9.7",
        "10.6",
        "10.8",
        "11.5"
      ]
    },
    {
      "id": 19,
      "tasks": [
        "10.9",
        "11.6",
        "15.2"
      ]
    },
    {
      "id": 20,
      "tasks": [
        "11.7",
        "12.1"
      ]
    },
    {
      "id": 21,
      "tasks": [
        "12.2",
        "13.1"
      ]
    },
    {
      "id": 22,
      "tasks": [
        "12.3",
        "13.4"
      ]
    },
    {
      "id": 23,
      "tasks": [
        "12.4"
      ]
    },
    {
      "id": 24,
      "tasks": [
        "12.5",
        "13.2"
      ]
    },
    {
      "id": 25,
      "tasks": [
        "12.6",
        "13.3",
        "14.1",
        "15.3"
      ]
    },
    {
      "id": 26,
      "tasks": [
        "13.5",
        "13.6",
        "13.7",
        "14.2",
        "15.4"
      ]
    },
    {
      "id": 27,
      "tasks": [
        "13.8",
        "14.3",
        "14.4"
      ]
    },
    {
      "id": 28,
      "tasks": [
        "14.5",
        "15.5"
      ]
    },
    {
      "id": 29,
      "tasks": [
        "15.6"
      ]
    },
    {
      "id": 30,
      "tasks": [
        "15.7"
      ]
    },
    {
      "id": 31,
      "tasks": [
        "16"
      ]
    },
    {
      "id": 32,
      "tasks": [
        "17.1"
      ]
    },
    {
      "id": 33,
      "tasks": [
        "17.2"
      ]
    },
    {
      "id": 34,
      "tasks": [
        "17.3"
      ]
    },
    {
      "id": 35,
      "tasks": [
        "18"
      ]
    },
    {
      "id": 36,
      "tasks": [
        "19.1",
        "20.1",
        "20.2",
        "20.3",
        "21.1",
        "21.3",
        "22.1",
        "22.3",
        "23.1",
        "24.5",
        "24.9",
        "26.1"
      ]
    },
    {
      "id": 37,
      "tasks": [
        "19.2",
        "19.5",
        "20.4",
        "21.2",
        "21.5",
        "22.2",
        "22.4",
        "23.2",
        "23.3",
        "26.2"
      ]
    },
    {
      "id": 38,
      "tasks": [
        "19.3",
        "19.4",
        "19.6",
        "19.9",
        "21.4",
        "22.5",
        "23.4"
      ]
    },
    {
      "id": 39,
      "tasks": [
        "19.7",
        "19.8",
        "19.10",
        "23.5",
        "24.1",
        "24.4",
        "24.6",
        "24.7"
      ]
    },
    {
      "id": 40,
      "tasks": [
        "24.2",
        "24.3",
        "24.8",
        "24.10"
      ]
    },
    {
      "id": 41,
      "tasks": [
        "25.1",
        "25.3",
        "25.4",
        "26.3",
        "26.4"
      ]
    },
    {
      "id": 42,
      "tasks": [
        "25.2",
        "25.5"
      ]
    },
    {
      "id": 43,
      "tasks": [
        "25.6"
      ]
    },
    {
      "id": 44,
      "tasks": [
        "27"
      ]
    },
    {
      "id": 45,
      "tasks": [
        "28.1"
      ]
    },
    {
      "id": 46,
      "tasks": [
        "28.2"
      ]
    },
    {
      "id": 47,
      "tasks": [
        "28.3"
      ]
    },
    {
      "id": 48,
      "tasks": [
        "28.4",
        "29.1"
      ]
    },
    {
      "id": 49,
      "tasks": [
        "29.2",
        "29.3"
      ]
    },
    {
      "id": 50,
      "tasks": [
        "29.4"
      ]
    },
    {
      "id": 51,
      "tasks": [
        "30"
      ]
    }
  ]
}
```

## Notes

- Tasks marked with * are optional and can be skipped for a faster MVP.
- Each checkpoint depends on every earlier task, and every later task depends on the latest checkpoint before it.
- Phase 0 probe results (Requirement 45) decide which fallback paths later tasks build; a task that depends on a probe follows the recorded result.
- Tasks 28 and 29 must not create production credentials or publish a production URL before the promotion gate audit (Requirement 44) passes.
- Property 6 (business logic) has no test task; the design marks it untestable without repository tests.
