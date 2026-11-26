# Requirements Document

## Introduction

The resurrection engine (Git-Graveyard) takes a dormant public GitHub repository and tries to bring it back. It has two paths. The Grimoire autopsy is instant and rule-based; it runs no model and no repository code. A live run is open only to invite-code holders and is driven by the Necromancer, a long-running service. The Necromancer clones the repository, runs its install, build and tests in a sandbox (Exhume), has a Planner session write a Pact, and, after the user approves the Pact, raises a Legion of Skeletons (separate Kiro CLI sessions) that change the code in isolated worktrees under a read-only Warden's review. A change merges only after a Warden `approve` verdict and a passing Grimoire gate. Runs are detached from the browser, recorded in an append-only event store, and can be replayed.

These requirements are derived from `design.md` Revision 4 (decisions E1 to E12, sections R4-0 to R4-23) and from the Revision 1 to 3 parts that R4-0 keeps in force: the Grimoire rules M1 to M6 as amended by R3-8, input normalization (R3-6), detection (R3-7), gates (R3-9), dead or alive (R3-11) and properties P1 to P8 (P4 as amended in R3-18). Where R4 marks a fact unknown, the requirement names the Phase 0 probe or spike that settles it and the fallback behaviour; no value is invented. Settings that R4 leaves without a starting value are configured by the admin, and the Necromancer refuses live runs until they are set.

| Requirements | Design sections |
|---|---|
| 1 to 5 | R3-6, R3-7, R3-11, R3-4, R3-15, R4-13 |
| 6 to 10 | R1 mapping and adapter, R3-8, R3-9, R3-10, R4-8 Grimoire gate, R4-22 P9 |
| 11 to 13 | R4-8 |
| 14 to 17 | R4-3, R4-4 |
| 18 to 20 | R4-5, R4-6 |
| 21, 22 | R4-16 |
| 23 to 26 | R4-8, R4-11, R4-14 |
| 27 to 29 | R4-12 |
| 30, 31 | R4-15, E6 |
| 32, 33 | R4-9, E10 |
| 34 to 39 | R4-10, wp-d D2 |
| 40 | R4-13 |
| 41 | R4-14 |
| 42 | R4-16 |
| 43 | R4-7 |
| 44 | R4-17 |
| 45 | R4-19 |
| 46 | wp-d D2.10, R2-8 |
| 47 | wp-a A2, wp-d D2.10 |
| 48 | R3-14, R4-10 |

## Glossary

- **Necromancer**: The Node/TypeScript planner service that owns planning, scheduling and every policy decision of a live run. Its parts are the API and SSE server, Admission, Scheduler, SkeletonSupervisor, MCP_Gateway, Grimoire, GitService and the ExecutionBackend client.
- **Skeleton**: One `kiro-cli` session with a role-specific custom agent, raised by the Necromancer for one role and task.
- **Legion**: The set of live Skeletons in a run.
- **Planner**: The Skeleton (Opus 5.5) that writes the Pact and answers asks and revisions; with the Exhumer, the only Skeleton that runs before Pact approval.
- **Exhumer**: The Skeleton role made of the Exhumer_Harness plus a Haiku 5.5 triage session that reads the harness logs.
- **Exhumer_Harness**: Necromancer code that runs fixed install, build, test and version commands in the runbox without any model.
- **Bonesetter**: The builder Skeleton (Sonnet 5.5) that repairs manifests and lock files.
- **Soul-stitcher**: A builder Skeleton (Sonnet 5.5, Opus 5.5 for tasks marked `hard: yes`) that changes code in its own worktree.
- **Builder**: The Exhumer, a Bonesetter or a Soul-stitcher.
- **Warden**: The read-only reviewer Skeleton (Opus 5.5) with its own session, process, `KIRO_HOME`, checkout and auditbox; it can reject.
- **Scribe**: The Skeleton (Haiku 5.5) that writes the run report.
- **Grimoire**: The deterministic rule engine for rules M1 to M6 (detection, dead or alive, migration guidance, Grimoire bundle). It runs no model and no repository code.
- **Grimoire_Gate**: The Grimoire's syntax gate: per edit inside the Grimoire, and per candidate before merge.
- **Grimoire_Bundle**: The Grimoire's template-only `requirements.md`, `design.md` and `tasks.md` for one repository, with patch tasks and patch steps.
- **Request_Adapter**: The CommonJS adapter that keeps the `request` callback API on native `fetch` (rule M2).
- **Eligible_Call_Site**: A `request` call whose callee is the `request` binding, whose form is `request(opts, cb)` or `request.<verb>(opts, cb)` with verb in `get`, `post`, `put`, `patch`, `del`, `head`, whose `opts` is an object literal with keys only in `ALLOWED_KEYS`, whose `cb` is present, whose return value is unused, and whose file is `.js`, `.cjs`, `.mjs` or `.jsx`.
- **ALLOWED_KEYS**: The set of `request` option keys the Grimoire found in use in the repository.
- **Signal**: One Grimoire finding with rule ID, `file:line:column`, matched literal, confidence and manifest directory.
- **Signal_Chip**: The Tombstone control that shows signals of one rule ID.
- **Receipt**: The evidence link of a claim: `file:line` and rule ID for a signal; `cmd:`, `file:`, `gh:` or `ev:` references elsewhere.
- **Last_Words**: The first line of the default-branch head commit message, at most 120 characters.
- **asOf**: The time at which GitHub facts were read: the request time for a live autopsy, a pinned date for an offline test fixture.
- **Manifest_Directory**: A directory that holds `package.json` (Node) or a Python manifest (Python).
- **Residue**: Python 2 constructs counted by the Grimoire's residue list (R3-9).
- **Death_Certificate**: The stored baseline result of install, build and test on the base sha, with the Exhumer's failure classes.
- **Pact**: The plan for one repository: `requirements.md`, `design.md` and `tasks.md` written by the Planner and approved by the user. Each version has a `pactVersion`.
- **Pact_Parser**: Necromancer code that parses `tasks.md` into tasks with role, dependencies, files, acceptance command, `hard` flag and rule IDs.
- **Pact_Renderer**: Necromancer code that renders a parsed Pact back into `tasks.md` text.
- **Run**: One live attempt on one repository at one base sha, with phases `queued`, `exhume`, `plan`, `pact_review`, `legion`, `final_check`, `report`, `done`.
- **Task**: One `tasks.md` item with a state among `pending`, `ready`, `running`, `in_review`, `rejected`, `merged`, `failed`, `abandoned`, `skipped`, `blocked`.
- **Integration_Head**: The head of the run branch `graveyard/<runId>`.
- **Candidate**: A builder's task branch rebased on the Integration_Head, identified by `candidateSha256`.
- **Verdict**: A Warden result `approve` or `reject` with reasons, each carrying refs, and `candidateSha256`.
- **Lay_to_rest**: Stopping a Skeleton; its task becomes `abandoned`.
- **Reliquary**: The results page of a run.
- **Box**: A run sandbox container: a runbox or an auditbox.
- **Runbox**: The Box that holds the builders' worktrees.
- **Auditbox**: The separate Box that holds only the Warden's checkout.
- **SkeletonSupervisor**: Necromancer code that spawns Skeletons and speaks ACP to them; it contains the PermissionBroker, BudgetGovernor and EventTap.
- **ACP**: The Agent Client Protocol over stdio used with `kiro-cli acp --agent-engine=v3`.
- **Headless_Fallback**: The turn-based channel `kiro-cli chat --v3 --no-interactive --output-format stream-json` with `--resume-id`, used only if probe P1 fails.
- **PermissionBroker**: Necromancer code that answers every `session/request_permission` with a one-time option.
- **MCP_Gateway**: The MCP server inside the Necromancer that exposes the gateway tools to Skeletons with a per-Skeleton bearer token.
- **Command_Policy**: The committed policy file and classifier that sorts every `sandbox_exec` argv into `allowed`, `needs_approval` or `blocked`.
- **Hard_Block**: An action that no prompt, invite code, Necromancer decision or UI action can allow (R4-12 Tier 3 list).
- **ExecutionBackend**: The interface that creates, runs and destroys Boxes, with two implementations chosen by configuration.
- **InstaboxDockerBackend**: The development ExecutionBackend: plain Docker containers on the development Instabox box.
- **DockerCloudSandboxBackend**: The production ExecutionBackend: Docker Agentic Platform cloud sandboxes, deleted after each run.
- **Topology_P-B**: The production layout in which `kiro-cli` runs on the host and files move into and out of sandboxes through the SDK.
- **GitService**: Necromancer code that clones, manages worktrees, merges and pushes; it holds the only GitHub write token.
- **BudgetGovernor**: Necromancer code that enforces caps.
- **Admission**: Necromancer code that checks invite codes, caps, the FIFO queue and concurrency.
- **Scheduler**: Necromancer code that reads dependencies from tasks.md, manages task queues and dependency resolution, and dispatches ready tasks to Skeletons without a model call.
- **EventStore**: The append-only SQLite store of run events keyed by `(runId, seq)`, plus the RunStore of run records.
- **RunStore**: The SQLite store of mutable run state records.
- **EventTap**: Necromancer code that tags, redacts and persists every event before it is streamed.
- **Redactor**: The redaction layer used by the EventTap and the log writer.
- **Report_Check**: Necromancer code that checks every numeral and outcome claim in the Scribe's model-written text against stored evidence.
- **Invite_Code**: An access code issued personally by the owner, stored hashed with expiry, run count, caps and a push flag.
- **Code_Ceiling**: The caps attached to an Invite_Code.
- **Global_Ceiling**: The maximum allowable caps across all runs configured by the Admin.
- **Required_Setting**: An Admin setting that R4 leaves without a starting value: tool calls per run; credits per run and per day when credits are reported; approval wait; queue idle limit; Pact idle limit; repository size cap; Box CPU, memory, pids and disk; Broker watchdog limit.
- **Owner**: The project owner; the only person who issues Invite_Codes and the only Admin.
- **Admin**: A signed-in Owner session on the Admin_Page.
- **Fork**: A GitHub repository owned by the configured owner login that GitHub reports as a fork of the source repository.
- **Source_Repository**: The original repository being resurrected.
- **Recorded_Run**: A run that actually executed and whose events are in the EventStore.
- **Metric_Registry**: The R4-13 table (M1 to M31 metric rows) that lists every number the UI may show and its source.
- **Probe**: A Phase 0 check P1 to P17 (wp-c C9.5).
- **Spike**: A Phase 0 experiment S1 to S5 (wp-d D9.3).
- **Phase_0_Runbook**: The owner-run procedure on the dev box that executes the Probes and Spikes and records their results.
- **Promotion_Gate**: The E5 procedure and its Admin enforcement that must pass before production credentials or a production URL exist.
- **Security_Access_Audit**: The wp-c C11 checklist plus the R4 rows XR-01 to XR-03.
- **CI_Pipeline**: The repository's automated test runs.
- **Project_Hooks**: The build-time Kiro hooks in `.kiro/hooks/*.json`.
- **Evidence_Builder**: The script `npm run evidence:build` that writes `kiro-evidence.json`.
- **UI**: The Next.js pages served to browsers.
- **Gate**: The home page `/`.
- **Tombstone**: The page `/tomb/[owner]/[repo]` with the Grimoire diagnosis (section A) and Exhume (section B).
- **Pact_Screen**: The page `/runs/[runId]/pact`.
- **Legion_Dashboard**: The page `/runs/[runId]/legion`.
- **Run_Header**: The header shown on every run page.
- **History_Page**: The page `/history`.
- **Replay_Page**: The page `/replay/[runId]`.
- **Built_With_Kiro_Page**: The page `/built-with-kiro`.
- **Admin_Page**: The page `/admin`.

## Requirements

### Requirement 1: Repository input normalization

**User Story:** As a visitor, I want to paste any common form of a GitHub repository address, so that I can start an autopsy without reformatting it.

#### Acceptance Criteria

1. WHEN a visitor submits `https://github.com/<owner>/<repo>` with or without the scheme, a trailing slash, a `.git` suffix, a `/tree/...` or `/blob/...` path, a query or a fragment, THE Grimoire SHALL reduce the input to the pair `(owner, repo)`.
2. WHEN a visitor submits `git@github.com:<owner>/<repo>` with or without a `.git` suffix, THE Grimoire SHALL reduce the input to the pair `(owner, repo)`.
3. WHEN the input contains a ref in a `/tree/<ref>` path, THE Grimoire SHALL analyse the default-branch head commit instead of the ref.
4. WHEN the input contains a ref in a `/tree/<ref>` path, THE Tombstone SHALL state that the default-branch head is used.
5. IF the input host is not exactly `github.com`, or the input contains userinfo or a port, THEN THE Grimoire SHALL reject the input with error code `BAD_URL`.
6. IF `owner` or `repo` contains a character outside `[A-Za-z0-9_.-]`, or equals `.` or `..`, THEN THE Grimoire SHALL reject the input with error code `BAD_URL`.
7. THE Grimoire SHALL send outbound requests only to `api.github.com`, `codeload.github.com` and `registry.npmjs.org`, with every URL built from the validated `owner`, `repo` and `sha`.
8. WHEN displaying the repository name, THE Tombstone SHALL display the repository name from the GitHub API `full_name` field.

### Requirement 2: Autopsy fetch and archive limits

**User Story:** As a visitor, I want the autopsy to read only verified facts and to reject unsafe archives, so that the diagnosis is accurate and the server stays safe.

#### Acceptance Criteria

1. WHEN an autopsy starts, THE Grimoire SHALL read `full_name`, `default_branch`, `created_at`, `archived`, `stargazers_count` and `forks_count` from GitHub `GET /repos/{owner}/{repo}`.
2. WHEN the repository metadata has been read, THE Grimoire SHALL read the sha, committer date and message of the default-branch head commit from GitHub `GET /repos/{owner}/{repo}/commits/{default_branch}`.
3. WHEN the default-branch head commit has been read, THE Grimoire SHALL set `lastCommitAt` to the committer date of the default-branch head commit.
4. IF the default branch has no commit, THEN THE Grimoire SHALL fail the autopsy with error code `REPO_EMPTY`.
5. IF the repository does not exist, is private, or the requested sha is unknown, THEN THE Grimoire SHALL fail the autopsy with error code `REPO_NOT_FOUND`.
6. IF a GitHub call fails with a network error or a 5xx status twice in a row, THEN THE Grimoire SHALL fail the autopsy with error code `GITHUB_UNAVAILABLE`.
7. IF GitHub reports that the rate limit is exhausted, THEN THE Grimoire SHALL fail the autopsy with error code `RATE_LIMITED` and return the reset time.
8. IF the repository archive exceeds 20 MB compressed, 60 MB decompressed or 2000 entries, THEN THE Grimoire SHALL fail the autopsy with error code `TOO_LARGE`.
9. IF an archive entry has an absolute path or a `..` segment, or is a symlink or a hard link, THEN THE Grimoire SHALL fail the autopsy with error code `ARCHIVE_UNSAFE`.
10. WHEN extracting repository archive entries, THE Grimoire SHALL treat Git LFS pointer files as binary files that are not scanned.
11. WHEN extracting or scanning repository files, THE Grimoire SHALL scan no file inside a submodule path.
12. IF a text file is not valid UTF-8, THEN THE Grimoire SHALL mark the file `encoding_unsupported`.
13. IF an autopsy request reaches 20 seconds, THEN THE Grimoire SHALL stop the request with error code `TIMEOUT`.
14. WHILE performing an autopsy, THE Grimoire SHALL complete the autopsy without running any repository code.
15. WHILE performing an autopsy, THE Grimoire SHALL complete the autopsy without any model call.

### Requirement 3: Detection, inventory and languages

**User Story:** As a visitor, I want the Grimoire to find legacy patterns in real code only, so that every finding points at something that exists.

#### Acceptance Criteria

1. WHEN selecting files for detection, THE Grimoire SHALL scan only files named `package.json`, `*.js`, `*.cjs`, `*.mjs`, `*.jsx`, `*.ts`, `*.tsx`, `webpack.config.*`, `*.py`, `requirements*.txt`, `setup.py`, `pyproject.toml` and `Pipfile`.
2. WHEN inventorying lock files, THE Grimoire SHALL check the lock files `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock` and `Pipfile.lock` for existence only.
3. WHEN selecting files to scan, THE Grimoire SHALL scan at most 400 files, taken in path order.
4. WHEN at least one `package.json` exists, THE Grimoire SHALL include `node` in `languages`.
5. WHEN at least one `*.py` file or Python manifest exists, THE Grimoire SHALL include `python` in `languages`.
6. IF `languages` is empty, THEN THE Grimoire SHALL fail with error code `LANGUAGE_UNKNOWN` and name the files the Grimoire looked for.
7. WHEN assigning source files to directories, THE Grimoire SHALL assign each source file to its nearest ancestor Manifest_Directory, and assign Python files with no ancestor Manifest_Directory to the repository root.
8. WHEN ordering Manifest_Directories, THE Grimoire SHALL order Manifest_Directories with Node directories sorted by path first, then Python directories sorted by path.
9. IF more than 10 Manifest_Directories exist, THEN THE Grimoire SHALL process the first 10 in that order and record each remaining directory as `unknown` with reason `manifest_cap`.
10. WHEN scanning source files, THE Grimoire SHALL emit no Signal for a legacy pattern that occurs only inside a string literal or a comment.
11. WHEN emitting a Signal, THE Grimoire SHALL record on every Signal a rule ID, a `file:line:column`, a matched literal equal to the source text at that position, a confidence of `high` or `medium`, and the Manifest_Directory.
12. WHEN outputting Signals, THE Grimoire SHALL sort Signals by `(file, line, column, ruleId)`.
13. IF an original JavaScript, TypeScript or Python file cannot be parsed, THEN THE Grimoire SHALL record the file as `unknown` with reason `original_unparseable` and continue with the remaining files.

### Requirement 4: Dead or alive

**User Story:** As a visitor, I want a clear dead-or-alive verdict with its reasons, so that I know why the repository is considered dead.

#### Acceptance Criteria

1. WHEN GitHub reports `archived` as true, THE Grimoire SHALL add the reason `archived`.
2. WHEN `lastCommitAt` is earlier than `asOf` minus 24 calendar months, THE Grimoire SHALL add the reason `dormant_24m`.
3. WHEN at least one Signal has confidence `high` and a rule ID in M1 to M4, THE Grimoire SHALL add the reason `deprecation_signal`.
4. WHEN evaluating the `deprecation_signal` reason, THE Grimoire SHALL exclude M5 and M6 Signals from the `deprecation_signal` reason.
5. WHEN determining dead-or-alive status, THE Grimoire SHALL set status `dead` when at least one reason holds and status `alive` when no reason holds.
6. WHILE the status is `alive`, THE Tombstone SHALL show the label "still breathing" and keep the full autopsy visible.
7. WHEN computing repository lifespan, THE Grimoire SHALL compute `lifespanYears` as `(lastCommitAt - createdAt) / 365.25 days`, rounded to one decimal.
8. IF the computed lifespan is negative, THEN THE Grimoire SHALL report `lifespanYears` as `unknown`.
9. WHEN computing years dead, THE Grimoire SHALL compute `yearsDead` as `(asOf - lastCommitAt) / 365.25 days`, rounded to one decimal.
10. WHEN performing a live autopsy, THE Grimoire SHALL set `asOf` to the request time of the autopsy.
11. WHERE the input is a committed offline test fixture, THE Grimoire SHALL use the `asOf` date pinned in the fixture snapshot.

### Requirement 5: Last Words, receipts and signal chips

**User Story:** As a visitor, I want every claim on the Tombstone to link to its evidence, so that I can check the diagnosis myself.

#### Acceptance Criteria

1. WHEN extracting the commit message, THE Grimoire SHALL take Last_Words from the first line of the default-branch head commit message, truncated to 120 characters.
2. WHEN displaying Last_Words, THE Tombstone SHALL render Last_Words as plain text with every markup character escaped.
3. WHEN displaying Signal_Chips, THE Tombstone SHALL group Signal_Chips by rule ID M1 to M6.
4. WHEN rendering a Signal_Chip, THE Tombstone SHALL show on every Signal_Chip a Receipt with the Signal's rule ID and `file:line`.
5. WHEN a user opens a Receipt, THE Tombstone SHALL show the source line at the recorded `file:line` of the analysed sha.
6. WHEN a user activates the copy control of a Signal_Chip, THE Tombstone SHALL copy the Signal's `file:line` to the clipboard.
7. WHEN displaying the autopsy diagnosis, THE Tombstone SHALL show the sentence "Grimoire's instant verdict is rule-based and has not run your code." with the diagnosis.
8. WHEN generating the autopsy `cause` text, THE Grimoire SHALL generate the autopsy `cause` text from templates only.

### Requirement 6: Grimoire rule traceability and M1 Python rules

**User Story:** As a Skeleton receiving migration guidance, I want every Grimoire finding and edit tied to a modernization rule, so that I can check the guidance against the rule text.

#### Acceptance Criteria

1. WHEN emitting a Signal, task or patch step, THE Grimoire SHALL cite exactly one rule ID from M1 to M6 on every Signal, task and patch step that the Grimoire emits.
2. WHEN writing mapping rows into a Grimoire_Bundle `design.md`, THE Grimoire SHALL cite a rule ID from M1 to M6 on every mapping row.
3. IF the Grimoire cannot determine an item, THEN THE Grimoire SHALL record the item as `unknown` with a reason code.
4. WHEN a Python file contains a `print` statement with no chevron and no trailing comma, THE Grimoire SHALL rewrite the statement as a `print(...)` call with the same arguments, including statements that span several lines.
5. WHEN a Python `print` statement ends with a trailing comma, THE Grimoire SHALL rewrite the statement with `end=" "`, set confidence `medium` and add a behavior note that Python 2 softspace output is not identical.
6. WHEN a Python `print` statement uses a chevron `>>f`, THE Grimoire SHALL rewrite the statement with `file=f`, and with `end=" ", file=f` if the statement also ends with a trailing comma.
7. WHEN a Python statement consists only of the identifier `print`, THE Grimoire SHALL rewrite the statement as `print()`.
8. WHEN a Python file without `from __future__ import print_function` contains a `print(...)` call with two or more arguments, THE Grimoire SHALL leave the call unchanged and add a behavior note that Python 2 prints a tuple.
9. WHEN a Python `except` clause has the form `except E, e:`, THE Grimoire SHALL rewrite the clause as `except E as e:`.
10. WHEN a Python file calls the identifier `unicode(...)`, THE Grimoire SHALL rewrite the call as `str(...)` with confidence `medium`.
11. IF a Python file binds the name `unicode`, or the call has the form `obj.unicode(...)`, THEN THE Grimoire SHALL leave the code unchanged and record `unknown` with reason `unicode_rebound`.
12. WHEN a Python file calls `.iteritems()`, `.iterkeys()` or `.itervalues()`, THE Grimoire SHALL rewrite the call as `.items()`, `.keys()` or `.values()` with confidence `medium`.
13. IF an iterator call is the argument of `next(...)` or is followed by `.next()`, THEN THE Grimoire SHALL leave the call unchanged and record `unknown` with reason `iterator_use`.
14. WHEN a Python file contains Python 2 Residue that no M1 row rewrites (`exec`, `<>`, backticks, `ur''` prefixes, octal literals such as `0777`, `L` suffixes, tuple parameters, `raise E, msg`), THE Grimoire SHALL record each occurrence as `unknown` with reason `py2_residue`.
15. WHEN applying M1 transformations to the output of a prior M1 transformation on a Python file, THE Grimoire SHALL produce no further edit.
16. IF two edits in one file have overlapping splices, THEN THE Grimoire SHALL skip the later edit and record `unknown` with reason `edit_conflict`.
17. WHEN applying edits to a file, THE Grimoire SHALL leave unchanged every byte outside edit ranges, including a byte order mark and line endings.
18. IF a file is not valid UTF-8, THEN THE Grimoire SHALL make no edit to the file.
19. IF a repository's declared Python requirement admits only Python 2, THEN THE Grimoire SHALL stop processing the repository and report the conflict with M1.

### Requirement 7: Grimoire M2 `request` migration

**User Story:** As a Skeleton receiving migration guidance, I want the `request` migration to keep the old callback behaviour exactly, so that call sites keep working on native `fetch`.

#### Acceptance Criteria

1. WHEN scanning source files, THE Grimoire SHALL tag as M2 every `require('request')`, `require("request")` and `import request from 'request'` in either quote style, and every import of `request-promise`, `request-promise-native` or `request-promise-any`.
2. IF a file imports a `request-promise` package, THEN THE Grimoire SHALL emit the Signal, make no edit and record `unknown` with reason `request_promise_unsupported`.
3. WHEN evaluating a file for M2 migration, THE Grimoire SHALL make an M2 edit in the file only when every `request` call site in the file is an Eligible_Call_Site.
4. IF a file uses `request.defaults`, `jar`, `.pipe`, a stream, `.on` or the return value of a `request` call, THEN THE Grimoire SHALL make no M2 edit in the file and record `unknown` with reason `request_unsupported_call`.
5. WHEN M2 fires in a Manifest_Directory, THE Grimoire SHALL add the Request_Adapter as a `.cjs` file at the Manifest_Directory root.
6. WHEN every call site in a file is an Eligible_Call_Site, THE Grimoire SHALL point the file's `request` specifier at the Request_Adapter and mark the step `compat: true` and `behavior: "unknown"`.
7. WHEN no file in a Manifest_Directory still imports `request`, THE Grimoire SHALL remove `request` from that directory's `dependencies`.
8. IF a file in the Manifest_Directory still imports `request` after the M2 edits, THEN THE Grimoire SHALL keep the dependency and record `unknown`.
9. WHEN M2 fires and `engines.node` is absent or has a minimum version below 22, THE Grimoire SHALL set `engines.node` to `">=22"` and add the note "requires Node 22 or later".
10. IF `engines.node` cannot be parsed, THEN THE Grimoire SHALL leave the field unchanged and record `unknown` with reason `engines_unparseable`.
11. WHEN invoked, THE Request_Adapter SHALL invoke the callback exactly once per call with the arguments `(err, response, body)`.
12. WHEN the Request_Adapter receives an HTTP response with status 400 or above and no network error, THE Request_Adapter SHALL pass `err = null`.
13. WHEN receiving an HTTP response, THE Request_Adapter SHALL set `response.statusCode` to the HTTP status of the received response.
14. WHEN the option `json: true` is set and the response body is not empty, THE Request_Adapter SHALL pass the body parsed as JSON.
15. IF a network error occurs, THEN THE Request_Adapter SHALL invoke the callback with the network error, a null response and a null body.
16. IF an option key is outside `ALLOWED_KEYS`, THEN THE Request_Adapter SHALL throw `UnsupportedOption` naming the key.

### Requirement 8: Grimoire M3 to M6 guidance

**User Story:** As a Skeleton receiving migration guidance, I want the Grimoire to report module, build, version and lock-file findings without guessing, so that I only act on facts.

#### Acceptance Criteria

1. WHEN classifying a `package.json` file, THE Grimoire SHALL determine the package kind, first match wins, as: already ESM when `type` is `module`; `unknown` when `workspaces` is set; application when `private` is true; library when `private` is not true, any of `exports`, `main` or `module` is set and `scripts.start` is not a string; application when `private` is not true, none of `exports`, `main` or `module` is set, and `scripts.start` is a string or `bin` is set; `unknown` otherwise.
2. IF a package is classified as library or `unknown`, THEN THE Grimoire SHALL leave the package in CommonJS and record `unknown` with reference U4.
3. WHERE M3 conversion is enabled, THE Grimoire SHALL convert application packages only, through AST transforms.
4. WHERE M3 conversion is enabled, IF a file uses `__dirname`, `__filename`, `require.resolve` or a conditional `require`, THEN THE Grimoire SHALL leave the file unchanged and record `unknown`.
5. WHERE M4 conversion is enabled, THE Grimoire SHALL target the current stable Vite version looked up at run time and record the `CommonsChunkPlugin` mapping as `unknown`.
6. WHEN a Node dependency's major version is at least 2 behind the latest registry version, THE Grimoire SHALL list the dependency in the report and leave the declared version unchanged.
7. WHEN evaluating dependency updates under M5, THE Grimoire SHALL apply an M5 version bump only when another rule forces the bump.
8. WHEN evaluating Python dependencies under M5, THE Grimoire SHALL record M5 for Python dependencies as `unknown`.
9. IF a registry lookup fails, THEN THE Grimoire SHALL keep the old version and record `unknown` with reason `registry_unavailable`.
10. WHEN a Manifest_Directory has no lock file from any package manager in the lock file list, THE Grimoire SHALL emit an M6 Signal for that directory.

### Requirement 9: Grimoire gates

**User Story:** As the owner, I want every Grimoire edit and every candidate change to pass a syntax gate, so that no change makes a file less parseable.

#### Acceptance Criteria

1. WHEN the Grimoire evaluates an M1 edit on a Python file, THE Grimoire_Gate SHALL accept the edit only if the parse-error count does not rise and the Residue count strictly falls.
2. IF the Grimoire_Gate rejects an M1 edit on a Python file, THEN THE Grimoire_Gate SHALL record unknown with the line number and the reason gate_errors_rose, gate_residue_not_reduced or parse_timeout.
3. WHEN emitting a Python file, THE Grimoire_Gate SHALL label the file m1-clean if the file's Residue count is zero and m1-partial otherwise.
4. IF no edit of a patch step is accepted, THEN THE Grimoire_Gate SHALL mark the step reverted with reason all_edits_rejected.
5. WHEN parsing an original JavaScript or TypeScript file, THE Grimoire_Gate SHALL parse the file as module if the file has the .mjs extension or sits under a package.json containing type: "module", and as script otherwise.
6. IF an original JavaScript or TypeScript file fails to parse, THEN THE Grimoire_Gate SHALL leave the file unchanged and record unknown with reason original_unparseable.
7. WHEN parsing a patched JavaScript or TypeScript file, THE Grimoire_Gate SHALL parse the file as module if an unreverted M3 step changed the file, and in the original file's mode otherwise.
8. IF a patched JavaScript or TypeScript file fails to parse, THEN THE Grimoire_Gate SHALL revert the last unreverted step for the file with reason parse_failed, recompute the mode, and reparse until the file parses.
9. WHEN a Builder submits a Candidate, THE Grimoire_Gate SHALL verify that every changed JavaScript or TypeScript file parses, using the mode given by the file's extension and the post-change package.json type.
10. WHEN a Builder submits a Candidate, THE Grimoire_Gate SHALL verify that every changed Python file has a parse-error count and a Residue count no higher than the same file at the Integration_Head.
11. WHEN the Grimoire_Gate finishes checking a Candidate, THE Necromancer SHALL emit a gate.result event with the syntax gate outcome.
12. WHERE a Candidate is submitted by a Builder, THE Necromancer SHALL run the Grimoire_Gate on the Candidate regardless of any instruction in the Pact, from the user, or from a Necromancer decision, and THE Necromancer SHALL not transition a Task to merged unless the Grimoire_Gate emits gate.result with ok = true on the candidate tree.
13. IF a Candidate fails the Grimoire_Gate check, THEN THE Necromancer SHALL return the gate failure reasons to the Builder without advancing the Task to Warden review or recording a Warden rejection.

### Requirement 10: Grimoire bundle and deterministic output

**User Story:** As the owner, I want the Grimoire's own output to be template-only and byte-reproducible, so that the rule engine can be tested exactly.

#### Acceptance Criteria

1. WHERE the Grimoire generates a Grimoire_Bundle, THE Grimoire SHALL write the Grimoire_Bundle from templates only, containing no model text.
2. WHERE text is written into the Grimoire_Bundle, THE Grimoire SHALL write every sentence with a rule ID citation from M1 to M6 or the word unknown.
3. WHEN drafting the Grimoire_Bundle, THE Grimoire SHALL write every task unchecked before patching starts.
4. WHERE the Grimoire produces a Grimoire_Bundle, THE Grimoire SHALL produce exactly one patch task for each (ruleId, file) pair that has a patch step, and exactly one patch step for each patch task.
5. WHEN finalizing the Grimoire_Bundle, THE Grimoire SHALL check a patch task if and only if the task's patch step is not reverted.
6. WHEN a patch task's patch step is reverted, THE Grimoire SHALL write an Outcome: line with the revert reason under the unchecked task.
7. WHEN finalizing the Grimoire_Bundle, THE Grimoire SHALL add an Outcome section to design.md with the count of tasks per status and the label of each Python file.
8. WHEN the Grimoire executes on inputs with the same (owner, repo, sha, engineVersion), the same registry answers and the same asOf, THE Grimoire SHALL produce byte-identical Signals, dead-or-alive result, patch plan and Grimoire_Bundle.
9. WHEN computing engineVersion, THE Grimoire SHALL derive engineVersion from a hash of the rule and engine sources so that any rule change produces a new engineVersion.
10. WHERE a Grimoire_Bundle is written, THE Grimoire SHALL exclude GitHub metadata, Last_Words, model text and timings from the Grimoire_Bundle.
11. WHEN finalizing the Grimoire_Bundle, THE Grimoire SHALL leave manual tasks unchecked, except for preset M6 tasks.

### Requirement 11: Exhume and death certificate

**User Story:** As an invited user, I want the repository installed, built and tested for real in a sandbox, so that I know exactly what fails today.

#### Acceptance Criteria

1. WHEN an invited user starts Exhume, THE GitService SHALL compare the GitHub size field with the repository size cap before cloning.
2. IF the GitHub size field exceeds the repository size cap, THEN THE Necromancer SHALL refuse the run before cloning and report the reason.
3. WHEN the repository size check passes, THE GitService SHALL clone the base sha that the autopsy resolved into git/ and create builders/base.
4. WHEN the clone completes, THE ExecutionBackend SHALL create one Runbox and one Auditbox for the run.
5. WHEN the Runbox is ready, THE Exhumer_Harness SHALL run, without any model call, the runtime version commands, the install command, the build command when a build script exists, and the test command.
6. WHEN running an npm install command, THE Exhumer_Harness SHALL pass --ignore-scripts.
7. WHEN installing Python dependencies, THE Exhumer_Harness SHALL execute pip or poetry according to the detected Python manifests.
8. IF the install command fails and the lockfile-aware retry with the other documented install command also fails, THEN THE Exhumer_Harness SHALL mark the build and the tests not run.
9. IF the repository has no build script, THEN THE Exhumer_Harness SHALL mark the build not run with the reason.
10. WHEN a Node repository has no scripts.test or only the default placeholder, or a Python repository gives pytest --collect-only exit code 5 or has no test files, THE Exhumer_Harness SHALL record "No tests found" with the rule that decided it.
11. WHEN Exhume runs, THE Necromancer SHALL run the Grimoire on the base tree and emit grimoire.signal and grimoire.summary events.
12. WHEN the harness commands finish, THE Necromancer SHALL raise the Exhumer triage session on Haiku 5.5 to read the logs and report the failure classes.
13. WHEN the Death_Certificate is stored, THE Necromancer SHALL emit an exhume.certificate event.
14. IF the run wall-clock cap is hit during Exhume, THEN THE Exhumer_Harness SHALL keep the completed rows and mark the rows not reached as not run with the reason time limit.
15. WHEN install, build and tests all pass and the user chooses "Stop here", THE Necromancer SHALL end the run with outcome healthy_already.
16. WHEN the Exhumer_Harness executes a command in the Runbox, THE Necromancer SHALL emit command.started and command.result events for the command.

### Requirement 12: Pact planning

**User Story:** As an invited user, I want the Necromancer to propose a checked plan that covers every failure, so that I can decide what the Legion will do.

#### Acceptance Criteria

1. WHEN the user requests a Pact after the Death_Certificate is stored, THE Necromancer SHALL raise the Planner session with the autopsy, the Death_Certificate and the Grimoire Signals as input.
2. WHERE the Planner performs file writes, THE Necromancer SHALL limit the Planner's writes to the run's spec/ directory.
3. WHEN drafting the Pact, THE Planner SHALL write spec/requirements.md, spec/design.md, and spec/tasks.md before calling report_task_result, and THE Pact_Parser SHALL parse spec/tasks.md when report_task_result is called.
4. WHEN parsing spec/tasks.md, THE Pact_Parser SHALL accept a task only as one checkbox line with an ID of the form T<n> followed by the metadata bullets role, depends, files, accept, hard and rules.
5. IF a task ID does not match T<n> or repeats, THEN THE Pact_Parser SHALL reject the Pact with an error naming the task.
6. IF a task's role is not bonesetter or soul-stitcher, THEN THE Pact_Parser SHALL reject the Pact with an error naming the task.
7. IF a task's depends names a missing ID or the dependencies form a cycle, THEN THE Pact_Parser SHALL reject the Pact with an error naming the missing ID or the cycle.
8. IF a task's files is empty or names a path outside the repository, THEN THE Pact_Parser SHALL reject the Pact with an error naming the task.
9. IF a task's accept command classifies as blocked under the Command_Policy, THEN THE Pact_Parser SHALL reject the Pact with an error naming the task.
10. IF a task's hard value is not yes or no, THEN THE Pact_Parser SHALL reject the Pact with an error naming the task.
11. IF a task's rules names anything outside M1 to M6, THEN THE Pact_Parser SHALL reject the Pact with an error naming the task.
12. WHEN rendering a parsed Pact, THE Pact_Renderer SHALL render the Pact back into tasks.md text in the grammar that the Pact_Parser accepts.
13. WHEN any valid parsed Pact is rendered by the Pact_Renderer and reparsed by the Pact_Parser, THE Pact_Parser SHALL produce an equivalent parsed Pact.
14. WHEN the Pact parses, THE Necromancer SHALL map every Death_Certificate failure to at least one task or list the failure under "Not addressed by any task".
15. WHEN parsing and the coverage check succeed, THE Necromancer SHALL emit a pact.drafted event.
16. WHILE a run is in the legion phase, THE Necromancer SHALL keep the Planner alive to answer asks and draft Pact revisions.
17. IF tasks.md fails parsing or the coverage check fails, THEN THE Necromancer SHALL display the parse error or coverage error on the Pact_Screen without emitting pact.drafted.

### Requirement 13: Pact review and approval

**User Story:** As an invited user, I want nothing to change my repository's copy until I approve the Pact, so that I stay in control of the work.

#### Acceptance Criteria

1. WHILE a run is in the pact_review phase, THE Necromancer SHALL pause the run clock.
2. WHEN the user edits the Pact on the Pact_Screen, THE Necromancer SHALL store the edited Pact as the next pactVersion and emit a pact.edited event.
3. WHEN the user requests a revision, THE Necromancer SHALL have the Planner draft a revision and emit a pact.revision event.
4. WHEN the user approves the Pact, THE Necromancer SHALL emit a pact.approved event with the pactVersion, the approvedTaskIds and the budget.
5. WHERE any Pact version is drafted or edited, THE Necromancer SHALL retain the Warden final check, the Scribe report and the Grimoire_Gate as non-removable requirements.
6. IF the user stays idle in pact_review past the Pact idle limit, THEN THE Necromancer SHALL park the run, keep the Pact and release the Runbox.
7. WHEN the user resumes a parked run, THE Necromancer SHALL re-queue the run with the same Pact and clone the repository again.
8. WHERE a Skeleton has the role Bonesetter, Soul-stitcher, Warden or Scribe, THE Necromancer SHALL raise the Skeleton only after a pact.approved event has been emitted for the run.
9. WHERE a run has not received Pact approval, THE Necromancer SHALL raise the Exhumer only after a run.started event and raise the Planner only after an exhume.certificate event.
10. WHEN the Planner drafts a revision during the legion phase, THE Necromancer SHALL raise a Skeleton for a new or changed task only after the user approves the revision.
11. THE Scheduler SHALL meet Requirement 23.7.

### Requirement 14: Skeleton roles and agent files

**User Story:** As the owner, I want every Skeleton to hold only the tools its role needs, so that a misbehaving session cannot reach beyond its job.

#### Acceptance Criteria

1. WHEN raising a Skeleton, THE Necromancer SHALL spawn the Skeleton as a separate kiro-cli process with its own custom agent for exactly one of the roles Planner, Exhumer, Bonesetter, Soul-stitcher, Warden and Scribe.
2. WHEN a Skeleton is spawned, THE Necromancer SHALL first copy the role's agent template, committed in this repository, unchanged into the Skeleton's $KIRO_HOME/agents/.
3. WHERE a Skeleton has the role Planner, THE Necromancer SHALL configure the agent with only the tools read, write, report_task_result and ask, with writes limited to spec/**.
4. WHERE a Skeleton has the role Exhumer, THE Necromancer SHALL configure the agent with only the tools read, sandbox_exec, sandbox_log and report_task_result, granting no write tool.
5. WHERE a Skeleton has the role Bonesetter, THE Necromancer SHALL configure the agent with only the tools read, write, sandbox_exec, sandbox_log, report_task_result, ask, report_blocker and ack_message, with writes limited to manifest and lock file names in the Bonesetter's own worktree under the read-workspace policy preset with an agent allow rule for those names.
6. WHERE a Skeleton has the role Soul-stitcher, THE Necromancer SHALL configure the agent with only the Bonesetter tools plus propose_task, with writes limited to the Soul-stitcher's own worktree outside .git/** and .kiro/**.
7. WHERE a Skeleton has the role Warden, THE Necromancer SHALL configure the agent with only the tools read, sandbox_exec, sandbox_log and warden_verdict, providing no write tool.
8. WHERE a Skeleton has the role Scribe, THE Necromancer SHALL configure the agent with only the tools read, write, report_task_result and ack_message, with writes limited to report/**.
9. WHERE an agent file is generated for any Skeleton, THE Necromancer SHALL set excludedTools to ["shell", "web", "subagent"] and configure permissions.rules to deny shell, web_fetch, web_search and subagent.
10. WHERE an agent file is generated for any Skeleton, THE Necromancer SHALL configure permissions.rules to deny fs_read on **/.env, **/.env.*, **/*.pem and **/id_*.
11. WHERE an agent file is generated for any Skeleton, THE Necromancer SHALL configure permissions.rules to deny fs_write on **/.git/** and **/.kiro/**.
12. WHERE an agent file is generated for any Skeleton, THE Necromancer SHALL set includeMcpJson to false, set includePowers to false, and specify a pinned model.
13. WHEN initializing a Skeleton's KIRO_HOME, THE Necromancer SHALL set chat.disableInheritingDefaultResources to true.
14. WHEN a Skeleton is raised for a task, THE Necromancer SHALL put the Grimoire guidance for the task's rule IDs into the role's steering resources, within 32 files and 100,000 characters.
15. WHEN raising any Skeleton, THE Necromancer SHALL disable sub-agents.
16. WHEN raising a Soul-stitcher for a task, THE Necromancer SHALL assign the Soul-stitcher its own worktree.
17. WHERE a Warden is raised for a run, THE Necromancer SHALL ensure that the Warden operates in a session, process, KIRO_HOME, checkout and Box disjoint from all Builders.
18. WHEN assigning policy presets to Skeleton roles, THE Necromancer SHALL assign the edit-workspace policy preset to Planner, Soul-stitcher and Scribe, and assign the read-workspace policy preset to Exhumer, Bonesetter and Warden.

### Requirement 15: Model allowlist

**User Story:** As the owner, I want every Skeleton to run on the latest allowed Claude tier for its role, so that cost and quality are predictable.

#### Acceptance Criteria

1. WHERE models are configured, THE Necromancer SHALL hold a model allowlist containing exactly the three model IDs that Probe P4 records for Claude Haiku 5.5, Claude Sonnet 5.5 and Claude Opus 5.5.
2. WHERE the model allowlist is populated, THE Necromancer SHALL exclude Auto from the model allowlist.
3. WHEN assigning a model tier to a Skeleton role, THE Necromancer SHALL assign Claude Opus 5.5 to the Planner and the Warden, Claude Sonnet 5.5 to Bonesetters and Soul-stitchers, and Claude Haiku 5.5 to the Exhumer triage session and the Scribe.
4. WHEN a task is marked hard: yes, THE Scheduler SHALL raise the task's Soul-stitcher on Opus 5.5.
5. WHEN session/new returns, THE SkeletonSupervisor SHALL read the active model from configOptions and compare the model with the model allowlist and the role's assigned tier.
6. IF the active model is outside the model allowlist or differs from the role's assigned tier, THEN THE SkeletonSupervisor SHALL fail the Skeleton with reason model_mismatch before sending any session/prompt.
7. IF the active mode is not the role's agent, THEN THE SkeletonSupervisor SHALL fail the Skeleton before sending any session/prompt.
8. WHEN the model, mode and gateway checks pass, THE SkeletonSupervisor SHALL emit a skeleton.raised event with the verified model ID, sessionId, and agent fields.
9. IF Probe P4 records no allowed model ID, THEN THE Necromancer SHALL keep live runs disabled.
10. WHILE Probe P4 has not recorded the effort values, THE Necromancer SHALL leave every Skeleton's effort at the default.

### Requirement 16: ACP channel

**User Story:** As the owner, I want each Skeleton driven over a verified ACP session, so that the Necromancer can monitor, correct and stop it at any time.

#### Acceptance Criteria

1. WHEN spawning a Skeleton, THE SkeletonSupervisor SHALL spawn the process as kiro-cli acp --agent-engine=v3 running as the skel user.
2. WHEN spawning a Skeleton, THE SkeletonSupervisor SHALL set the process environment to exactly KIRO_API_KEY, KIRO_HOME, HOME and PATH.
3. WHEN initializing an ACP session for a Skeleton, THE SkeletonSupervisor SHALL register handlers for session/update and session/request_permission before sending session/new.
4. WHILE Probe P2 has not recorded that Kiro calls client fs/* or terminal/* methods, THE SkeletonSupervisor SHALL answer every fs/*, terminal/* and unknown agent-to-client request with a JSON-RPC error.
5. WHEN initialize returns, THE SkeletonSupervisor SHALL store the advertised capabilities and send an optional method only when the method is advertised.
6. IF the initialize reply asks for a login, THEN THE SkeletonSupervisor SHALL fail the spawn with reason auth_failed.
7. WHEN establishing an ACP session, THE SkeletonSupervisor SHALL send session/new with the Skeleton's cwd, the MCP_Gateway entry with a per-Skeleton bearer token, the role's modeId, modelId and policy preset, and include additionalDirectories containing the read-only repository snapshot path for the Planner.
8. WHERE the SkeletonSupervisor specifies a policy preset in session/new, THE SkeletonSupervisor SHALL request edit-workspace for Planner, Soul-stitcher and Scribe, and request read-workspace for Exhumer, Bonesetter and Warden, configuring Bonesetter with an agent allow rule for manifest and lock file names.
9. IF neither an advertised MCP status method nor the MCP_Gateway's connection record shows the Skeleton connected, THEN THE SkeletonSupervisor SHALL fail the Skeleton with reason gateway_missing before sending any session/prompt.
10. WHERE a session/prompt call has been sent, THE SkeletonSupervisor SHALL treat the call as complete only when the prompt response arrives.
11. WHEN a session/update arrives, THE EventTap SHALL tag the update with run, Skeleton, task and toolCallId, redact the update, and persist the event before the event is sent over SSE.
12. WHERE _session/steer is advertised, THE SkeletonSupervisor SHALL deliver a correction during the current turn through _session/steer.
13. WHERE _session/steer is not advertised, THE SkeletonSupervisor SHALL wait for the current tool call to complete, send session/cancel, wait for the pending prompt response, and send the correction as a new session/prompt.
14. WHEN a Skeleton is cancelled, THE SkeletonSupervisor SHALL send session/cancel, wait up to 10 seconds for the prompt response, send SIGTERM to the process group, and send SIGKILL 5 seconds later if the process group is still running.
15. WHEN a Skeleton has returned its typed result tool call and its prompt response, THE SkeletonSupervisor SHALL end the process, archive the Skeleton's sessions folder into the run evidence, and delete the rest of the Skeleton's KIRO_HOME.
16. IF a kiro-cli process exits unexpectedly, THEN THE SkeletonSupervisor SHALL respawn the process once with the same KIRO_HOME and session/load, resending mcpServers, cwd and the policy preset, and send the instruction "continue from the current tree state".
17. WHEN the SkeletonSupervisor respawns a crashed Skeleton, THE SkeletonSupervisor SHALL send the continue instruction without any copy of the lost prompt.
18. IF an ACP initialize reply asks for a login, THEN Admission SHALL stop admitting live runs.
19. WHEN processing a session/update stream, THE EventTap SHALL map tool calls to skeleton.tool_call and skeleton.tool_result events, map agent text to skeleton.log events with stream agent, and map session_info_update with turn_completion to skeleton.usage events.
20. WHEN context_usage is received in a session/update, THE EventTap SHALL route context_usage to the BudgetGovernor.
21. WHEN sending a prompt via session/prompt upon task dispatch, THE SkeletonSupervisor SHALL include the tasks.md item text, death certificate rows, and relevant Grimoire guidance in the prompt.

### Requirement 17: Headless fallback condition

**User Story:** As the owner, I want a defined fallback channel that is used only if ACP fails its probe, so that live runs keep their guarantees either way.

#### Acceptance Criteria

1. WHERE probe P1 is recorded as failed, THE SkeletonSupervisor SHALL use the Headless_Fallback as the execution channel.
2. WHILE the Headless_Fallback is active, THE SkeletonSupervisor SHALL run each turn as `kiro-cli chat --v3 --no-interactive` with the role's agent, the role's model, `--require-mcp-startup`, `--trust-tools` set to the exact gateway tool IDs, and `--output-format stream-json`.
3. WHEN a correction is started while the Headless_Fallback is active, THE SkeletonSupervisor SHALL start a new process with `--resume-id`.
4. WHILE the Headless_Fallback is active, THE SkeletonSupervisor SHALL write the raw output stream to disk before parsing the stream.
5. WHEN a command classifying as `needs_approval` is called while the Headless_Fallback is active, THE MCP_Gateway SHALL refuse the command and return an approval ID.
6. WHEN an approval is resolved while the Headless_Fallback is active, THE SkeletonSupervisor SHALL resume the session with `--resume-id`.
7. IF spike S2 shows that `--resume-id` does not resume with the workspace intact after an interrupt, THEN THE MCP_Gateway SHALL refuse every `needs_approval` command outright while the Headless_Fallback is active.
8. WHEN a headless process exits, THE SkeletonSupervisor SHALL map exit code 0 to success, 1 to failure, 3 to `gateway_missing` and 4 to a missing agent.
9. IF a headless process exits with code 4, THEN THE SkeletonSupervisor SHALL discard the process output.
10. IF probe P14 shows that the stream does not report the active model, THEN THE Necromancer SHALL keep live runs disabled while the Headless_Fallback is the only channel.
11. WHEN an `ask` tool call is received while the Headless_Fallback is active, THE MCP_Gateway SHALL treat the call as denied.
12. WHILE the Headless_Fallback is active, THE SkeletonSupervisor SHALL parse the output stream using the parser built from the probe P14 fixture.

### Requirement 18: PermissionBroker

**User Story:** As the owner, I want every permission request answered once and by policy, so that no Skeleton gains a lasting permission.

#### Acceptance Criteria

1. WHEN a `session/request_permission` arrives, THE PermissionBroker SHALL select exactly one offered option of kind `allow_once` or `reject_once`.
2. WHILE a run is active, THE PermissionBroker SHALL select no option of kind `allow_always` or `reject_always`, and leave every `permissions.yaml` file unchanged.
3. IF no one-time option of the needed kind is offered, THEN THE PermissionBroker SHALL select no option, answer `cancelled`, cancel the turn and emit `permission.anomaly`.
4. WHEN evaluating a permission request, THE PermissionBroker SHALL decide on the host-supplied identity (`toolCallId`, `_meta.kiro.consent`, `_meta.kiro.mcpTool`) and the arguments only, without considering request title or MCP annotations.
5. WHEN a permission request matches no specific rule, THE PermissionBroker SHALL select `reject_once`.
6. WHEN a request is an `fs_read` inside the Skeleton's `cwd` or `additionalDirectories` and outside the secret globs, THE PermissionBroker SHALL select `allow_once`.
7. WHEN a request is an `fs_read` anywhere else, including `/proc/**`, any `KIRO_HOME`, any home directory and symlink targets outside the root, THE PermissionBroker SHALL select `reject_once`.
8. WHEN a request is an `fs_write` inside the role's write scope, THE PermissionBroker SHALL select `allow_once`.
9. WHEN a request is an `fs_write` outside the role's write scope, including `.git/**` and `.kiro/**` or any `fs_write` from Exhumer or Warden, THE PermissionBroker SHALL select `reject_once`.
10. WHEN a request is an `mcp` call on a `necromancer/*` tool listed for the role, THE PermissionBroker SHALL select `allow_once`.
11. WHEN a request is an `mcp` call on a gateway tool not listed for the role or on any other server, THE PermissionBroker SHALL select `reject_once`.
12. WHEN a request is for `shell`, `web_fetch`, `web_search`, `subagent`, `skill` or `power`, THE PermissionBroker SHALL select `reject_once`.
13. WHEN the PermissionBroker answers a request, THE PermissionBroker SHALL emit `permission.decision` with `requestId`, `toolCallId`, role, capability, target, option kind and the matched rule.
14. IF a permission request stays unanswered past the PermissionBroker watchdog limit Required_Setting configured by the Admin, THEN THE PermissionBroker SHALL select `reject_once` and log a Necromancer bug.
15. WHERE probe P6 records the permission options offered by `kiro-cli`, THE PermissionBroker SHALL select `allow_once` or `reject_once` exclusively from the offered options matching the verified option shapes.

### Requirement 19: MCP gateway tools

**User Story:** As the owner, I want Skeletons to reach the Necromancer and the sandbox only through typed gateway tools, so that every action is checked and recorded.

#### Acceptance Criteria

1. WHERE incoming connections are received, THE MCP_Gateway SHALL accept connections only on `127.0.0.1`.
2. WHEN an MCP tool call is received, THE MCP_Gateway SHALL identify the calling Skeleton by its bearer token.
3. WHEN a tool call is received, THE MCP_Gateway SHALL accept the call only if the caller's role matches the tool role mapping: `sandbox_exec` and `sandbox_log` from Exhumer, Bonesetter, Soul-stitcher and Warden; `report_task_result` from Planner, Exhumer, Bonesetter, Soul-stitcher and Scribe; `warden_verdict` from Warden; `ask` from Planner, Bonesetter and Soul-stitcher; `report_blocker` from Bonesetter and Soul-stitcher; `propose_task` from Soul-stitcher; and `ack_message` from Bonesetter, Soul-stitcher and Scribe.
4. IF a tool call comes from a role not listed for the tool, THEN THE MCP_Gateway SHALL refuse the call.
5. IF the `cwd` of a `sandbox_exec` call lies outside the caller's own worktree, THEN THE MCP_Gateway SHALL refuse the call.
6. WHEN executing `sandbox_exec`, THE MCP_Gateway SHALL run a builder's command in the Runbox and the Warden's command in the Auditbox.
7. WHEN `sandbox_exec` is invoked, THE MCP_Gateway SHALL return a result within a bounded duration below the MCP request timeout recorded by probe P3.
8. WHEN a command finishes within the bounded duration, THE MCP_Gateway SHALL return `exit_code`, `stdout_tail`, `stderr_tail`, `truncated` and `log_ref`.
9. WHEN a command is still running at the bounded duration, THE MCP_Gateway SHALL return `{ status: "running", log_ref }`.
10. WHEN `sandbox_log` is called with `log_ref`, `offset` and `limit`, THE MCP_Gateway SHALL return that output slice and, once the command has finished, the exit status.
11. WHEN `ask` is called, THE MCP_Gateway SHALL return at once with "recorded; end your turn".
12. IF a `warden_verdict` call lacks a `target`, a `verdict` of `approve` or `reject`, `reasons` each with `refs`, or `candidateSha256`, THEN THE MCP_Gateway SHALL refuse the call.
13. WHEN `propose_task` is called, THE Necromancer SHALL record the proposal and ask the user before the scope grows.
14. IF probe P3 shows that `session/new` does not accept the HTTP gateway, THEN THE Necromancer SHALL connect Skeletons through a stdio shim over a Unix socket, spawned with an environment that omits `KIRO_API_KEY`.
15. WHEN `report_blocker` is called with `text` and `kind`, THE Necromancer SHALL record the blocker and take mitigating action.
16. WHEN `ack_message` is called with `msgId`, THE Necromancer SHALL mark the message as Acknowledged.
17. WHEN `report_task_result` is called with `taskId`, `status`, `summary` and `refs`, THE Necromancer SHALL record the typed task result.
18. WHEN `ask` is called, THE Necromancer SHALL deliver the answer later by steer or by a new prompt.
19. WHEN executing a command in a Box via `sandbox_exec`, THE MCP_Gateway SHALL emit `command.started` and `command.result`.

### Requirement 20: Command policy

**User Story:** As the owner, I want every sandbox command classified by a committed policy, so that dangerous commands never run and unusual ones need my approval.

#### Acceptance Criteria

1. WHEN a `sandbox_exec` call is evaluated, THE Command_Policy SHALL classify the argv as `allowed`, `needs_approval` or `blocked`, using only the policy file committed in this repository.
2. WHERE an Admin accesses the Admin_Page, THE Admin_Page SHALL display the committed policy file.
3. WHEN evaluating an argv inside the caller's worktree, THE Command_Policy SHALL classify as `allowed`: `git status`, `git diff`, `git log`, `git add`, `git commit` and `git checkout -b`; installs with the repository's declared manager against allowlisted registries (`npm ci`, `npm install`, `pip install -r`, `poetry install`); `npm run` for `build`, `test`, `lint` and `typecheck`; `pytest`; `python -m unittest`; and version commands.
4. WHEN evaluating an argv, THE Command_Policy SHALL classify every command on the Hard_Block list as `blocked`.
5. WHEN evaluating an argv not classified as `allowed` or `blocked`, THE Command_Policy SHALL classify the command as `needs_approval`, including any command that names a host outside the egress allowlist.
6. WHEN a command classifies as `needs_approval`, THE MCP_Gateway SHALL emit `approval.requested` and return status `approval_pending` with an `approvalId` and `expiresAt`.
7. WHEN the user approves a command once, THE MCP_Gateway SHALL bind the grant to `(skeletonId, sha256(argv), cwd)` and start a process for at most one later call that matches all three.
8. IF a grant is presented after its `expiresAt`, THEN THE MCP_Gateway SHALL treat the grant as void.
9. WHEN the user chooses "Approve this pattern for the run", THE Necromancer SHALL store a run-scoped pattern in the RunStore and leave every Kiro permission file unchanged.
10. WHEN a command classifies as `blocked`, THE MCP_Gateway SHALL start no process in any Box, emit `command.refused` with the argv and the reason, and return `{ status: "blocked", reason }` to the calling Skeleton.
11. WHEN a `sandbox_exec` command ends, THE ExecutionBackend SHALL kill the command's process group and every remaining process of the container user.
12. WHEN dispatching commands to the ExecutionBackend, THE MCP_Gateway SHALL pass commands strictly as argv arrays and never as shell strings.
13. THE Exhumer_Harness SHALL meet Requirement 11.6.
14. IF an approval request remains unanswered past its deadline, THEN THE Necromancer SHALL treat the command as denied and instruct the Skeleton to re-plan.

### Requirement 21: Run container isolation

**User Story:** As the owner, I want untrusted repository code confined to hardened boxes with no secrets, so that a hostile repository cannot reach keys, the host or the network.

#### Acceptance Criteria

1. WHEN creating a Box, THE ExecutionBackend SHALL instantiate the Box from an image pinned by digest that holds the Node and Python toolchains.
2. WHEN creating a Box, THE ExecutionBackend SHALL create the Box without a container socket, without privileged mode, with all capabilities dropped and with `no-new-privileges` set.
3. WHILE executing any process in a Box, THE ExecutionBackend SHALL run the process as a non-root user.
4. WHEN creating a Box, THE ExecutionBackend SHALL configure the Box with a read-only root filesystem, tmpfs scratch space, and CPU, memory, pids and disk limits taken from the Box size settings.
5. WHEN creating a Box, THE ExecutionBackend SHALL create the Box with an environment and files containing no secrets, including the Kiro API key.
6. WHEN configuring filesystem mounts for a Box, THE ExecutionBackend SHALL mount no `KIRO_HOME`, home directory, `/data` directory or `.git` directory into any Box.
7. WHEN the clone completes, THE ExecutionBackend SHALL create one Runbox and one separate Auditbox per run, each with its own checkout.
8. WHERE the Warden's checkout exists, THE ExecutionBackend SHALL make the checkout reachable only from the Auditbox.
9. WHEN configuring network egress for a Box, THE ExecutionBackend SHALL deny Box egress by default and allow only the hosts in the egress allowlist.
10. WHEN establishing the egress allowlist, THE Necromancer SHALL use the host list confirmed by the Phase 0 NE-01 and NE-02 evidence, starting from `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `github.com` and `codeload.github.com`.
11. WHEN enforcing network egress, THE ExecutionBackend SHALL block access from every Box to the Kiro host list recorded by probe P11 (with the NE-01/NE-02 evidence, wp-c C3), `api.github.com` and cloud metadata addresses.
12. WHILE a run is active, THE ExecutionBackend SHALL keep the run's network policy unchanged.
13. WHEN executing repository code, THE Necromancer SHALL execute code only through `sandbox_exec` inside a Box and never inside a Skeleton CLI session shell or host shell.
14. WHEN provisioning or interacting with any Box, THE Necromancer SHALL provide no GitHub credential to the Box.
15. WHERE the DockerCloudSandboxBackend executes `syncOut`, THE ExecutionBackend SHALL validate pulled files to reject absolute paths, parent directory traversals, `.git/` paths, `.kiro/` paths, symlinks, and files exceeding the size limit, exclude build outputs (`node_modules`, `dist`), and include sources, manifests, and lock files.
16. WHEN a run terminates, THE ExecutionBackend SHALL destroy every Box created for that run without creating any snapshot.

### Requirement 22: Host-side isolation and untrusted repository Kiro content

**User Story:** As the owner, I want the Kiro sessions and the host protected from the cloned repository, so that files in the repository cannot reconfigure a Skeleton or escape the worktree.

#### Acceptance Criteria

1. THE Necromancer SHALL run every `kiro-cli` process as the `skel` user, with no `docker` or `sudo` membership and no read access to Necromancer files.
2. WHEN executing `kiro-cli`, THE Necromancer SHALL run only `kiro-cli` version 3.1.0 whose `sha256` matches the release manifest, with auto-update off.
3. WHEN configuring a server, THE Necromancer SHALL set `telemetry.enabled false` and `app.disableAutoupdates true` on every server through a root-owned `KIRO_DEFAULT_SETTINGS` file.
4. WHEN configuring a server, THE Necromancer SHALL keep "Share Kiro content" off on every server, at the location that the Phase 0 KI-06 evidence records.
5. WHEN configuring host network filtering, THE Necromancer SHALL restrict outbound traffic of the `skel` user to the Kiro host list recorded by probe P11 (with the NE-01/NE-02 evidence, wp-c C3) and the loopback MCP_Gateway.
6. THE GitService SHALL keep every git directory outside every Box mount.
7. WHEN running git commands, THE GitService SHALL run git only as the `necro` user, with git hooks and fsmonitor disabled.
8. WHEN a prompt is about to be sent or a `sandbox_exec` command has ended, THE Necromancer SHALL scan the Skeleton's worktree for symlinks.
9. IF a symlink in a worktree resolves outside the worktree root, THEN THE Necromancer SHALL kill the Skeleton, quarantine the worktree and fail the run.
10. WHEN inspecting a cloned repository, THE Necromancer SHALL treat any `.kiro/` folder, `AGENTS.md` file or skill inside the repository as untrusted input.
11. IF probe P7 shows that an ACP session loads a `.kiro/` item, `AGENTS.md` or a skill from the worktree, THEN THE Necromancer SHALL remove those items from the worktree view and mark them `skip-worktree`, so that the patch does not show them as deleted.
12. IF a Candidate diff touches `.kiro/` or `.git/`, THEN THE Necromancer SHALL refuse the diff in the scope check.
13. WHERE the UI is served, THE UI SHALL be served by a separate unprivileged user that holds no secret and reaches the Necromancer API only on loopback.
14. WHEN worktree files change before a `sandbox_exec` command or before a Candidate diff reaches the Grimoire_Gate, THE Necromancer SHALL scan the changed files for secrets.
15. IF a secret is found in changed worktree files, THEN THE Necromancer SHALL quarantine the worktree.

### Requirement 23: Scheduler

**User Story:** As an invited user, I want tasks dispatched in dependency order from the approved Pact, so that each Skeleton starts from merged work it depends on.

#### Acceptance Criteria

1. WHEN evaluating task dependencies, THE Scheduler SHALL read task dependencies only from the approved `tasks.md`.
2. WHEN every dependency of a `pending` task is `merged`, THE Scheduler SHALL set the task `ready`.
3. WHEN a dependency of an open task becomes `failed`, `abandoned` or `skipped`, THE Scheduler SHALL set the task `blocked`.
4. WHEN a task becomes `blocked`, THE Necromancer SHALL ask the user how to proceed.
5. WHILE tasks are scheduled, THE Scheduler SHALL keep the number of live Skeletons at or below the minimum of the run's parallel cap, the global Skeleton cap and the ExecutionBackend's `runningMax`.
6. WHEN the Scheduler dispatches a ready task, THE GitService SHALL create the branch `task/<taskId>` from the current Integration_Head with the task's own worktree, and THE Scheduler SHALL set the task state to running.
7. WHEN raising a Skeleton, THE Scheduler SHALL raise a Skeleton only for a task in the `approvedTaskIds` of the latest approved `pactVersion`.
8. THE Scheduler SHALL make all dispatch decisions without a model call.
9. WHEN every task is terminal, the user requests Stop, or a budget cap is exceeded, THE Scheduler SHALL stop dispatching tasks.
10. WHEN the user re-plans the dependency of a `blocked` task, THE Scheduler SHALL set the task `ready`.
11. WHEN a task is turned off in the Pact, THE Scheduler SHALL set the task `skipped`.
12. WHEN a task's Skeleton has used all of its attempts, THE Scheduler SHALL set the task `failed`.
13. WHEN a task's Skeleton is laid to rest, THE Scheduler SHALL set the task `abandoned`.
14. WHEN slots are available for dispatch, THE Scheduler SHALL dispatch ready tasks in priority order as listed in `tasks.md`.
15. WHEN the Scheduler raises a Skeleton for a Soul-stitcher task, THE Scheduler SHALL assign Opus 5.5 if the task is marked `hard: yes`, and Sonnet 5.5 otherwise.
16. WHEN the Scheduler dispatches a task, THE Necromancer SHALL deliver a prompt via `session/prompt` that includes the `tasks.md` item text, death certificate rows, and relevant Grimoire guidance.

### Requirement 24: Warden review and verdicts

**User Story:** As an invited user, I want an independent reviewer that runs the checks itself, so that no builder grades its own work.

#### Acceptance Criteria

1. WHEN `pact.approved` is emitted, THE Necromancer SHALL raise exactly one Warden per run.
2. WHEN Candidates are ready for review, THE Necromancer SHALL send Candidates to the Warden one at a time.
3. WHEN a Candidate passes the scope check, the secret scan and the Grimoire_Gate, THE Necromancer SHALL set the task `in_review` and send the Candidate to the Warden.
4. WHEN a review starts, THE ExecutionBackend SHALL reset the Auditbox checkout to the Integration_Head plus the Candidate.
5. WHEN the Warden reviews a Candidate, THE Warden SHALL run install, build, the task's `accept` command and the repository's tests in the Auditbox.
6. WHEN the Warden reviews a Candidate, THE Warden SHALL check `no_test_weakening` by comparing the test files and the collected test counts before and after the Candidate.
7. IF every reason of a `reject` Verdict lacks a ref, THEN THE Necromancer SHALL leave `rejectCount` unchanged and ask the Warden to rerun with evidence.
8. WHERE a Warden reason lacks a ref, THE UI SHALL tag the reason as "no evidence cited".
9. WHEN the Warden rejects a task and `rejectCount` stays below the Warden rejection rounds setting, THE Necromancer SHALL set the task `rejected` and re-dispatch the task with the Warden's reasons attached.
10. THE Necromancer SHALL meet Requirement 25.9.
11. WHEN the Necromancer re-dispatches a rejected task and the Skeleton's process is alive, THE Necromancer SHALL reuse the same session.
12. WHEN the Necromancer re-dispatches a rejected task and the Skeleton's process has ended, THE Necromancer SHALL start a fresh session with the Warden's reasons attached.
13. WHEN every task is terminal, THE Warden SHALL check the Integration_Head in the Auditbox with install, build, the repository's tests and `no_test_weakening` against the base, or validate install, build, and lint or typecheck if present when the repository has no tests, leading to outcome `resurrected_build_only`, and give a run Verdict.
14. WHEN raising and configuring the Warden, THE Necromancer SHALL give the Warden a session, process, `KIRO_HOME`, checkout and Box that no Builder shares.
15. WHILE a run is active, THE Necromancer SHALL keep every host path that the Warden can write out of reach of every Builder process and Box.
16. IF a `reject` Verdict contains reasons without refs, THEN THE Necromancer SHALL reject the Candidate only when at least one reason includes a ref.
17. WHERE a user sends an instruction to the Warden, THE Necromancer SHALL accept only the `add_review_focus` intent, and reject any request to change a verdict or access the Warden's checkout.

### Requirement 25: Merge rule

**User Story:** As an invited user, I want a change to merge only when the Warden approved that exact change and the Grimoire gate passed, so that the result contains only reviewed work.

#### Acceptance Criteria

1. WHEN a Builder reports a Task done through report_task_result, THE GitService SHALL rebase the task branch onto the Integration_Head to form the Candidate.
2. IF the rebase of a task branch onto the Integration_Head conflicts, THEN THE Necromancer SHALL ask the user conflict_choice.
3. IF a Candidate modifies files outside the Task's files in scope, other than lock files generated by installs, THEN THE Necromancer SHALL return the rejection reason to the Skeleton and leave rejectCount unchanged.
4. THE Necromancer SHALL meet Requirement 41.19.
5. IF the Grimoire_Gate fails on a Candidate, THEN THE Necromancer SHALL emit gate.result with ok = false, return the gate reasons to the Skeleton, and leave rejectCount unchanged.
6. WHEN the Warden returns an approve Verdict with a candidateSha256 equal to the Candidate's sha256 and the Integration_Head is unchanged since the review started, THE GitService SHALL fast-forward the Integration_Head to the Candidate.
7. WHEN a Task transitions to merged, THE Necromancer SHALL require that an approve Verdict for the same candidateSha256 and a gate.result event with ok = true for the same tree both precede the task.state merged event in the EventStore.
8. IF an approve Verdict names a different candidateSha256 or the Integration_Head moved during the review, THEN THE Necromancer SHALL leave the Task unmerged.
9. WHEN a Task reaches the Warden rejection rounds setting, THE Necromancer SHALL set the Task state to failed, set its dependent tasks to blocked, and ask the user stuck_after_rejections with options re-plan, skip, and stop.
10. THE Necromancer SHALL meet Requirement 24.3.
11. WHEN a Task is set to merged following a fast-forward merge, THE Necromancer SHALL transition the Builder Skeleton to laid_to_rest.

### Requirement 26: Run completion, report and artifacts

**User Story:** As an invited user, I want a checked report and stored artifacts when the run ends, so that I can download and verify exactly what happened.

#### Acceptance Criteria

1. WHEN a Run progresses through its lifecycle, THE Necromancer SHALL advance the Run through the phases queued, exhume, plan, pact_review, legion, final_check, report, and done in that order unless terminated early by user action, errors, or healthy_already, and emit run.phase on each transition.
2. WHEN a Run terminates, THE Necromancer SHALL end the Run with exactly one outcome among resurrected, resurrected_build_only, partial, not_resurrected, healthy_already, cancelled, killed, budget_stopped, and error.
3. WHEN evaluating a Run for the resurrected outcome, THE Necromancer SHALL assign the outcome resurrected only when the final_check build and repository tests have passed.
4. WHEN the final_check phase finishes, THE Necromancer SHALL raise the Scribe.
5. WHEN drafting the run report, THE Scribe SHALL write a Findings section generated from event data by templates and a separate model-written section titled "Scribe's reading".
6. WHEN the Scribe finishes drafting the report, THE Report_Check SHALL verify that every numeral and every "passed", "failed", "fixed", or "removed" claim in "Scribe's reading" carries a cmd:, file:, gh:, or ev: marker that exists and whose stored value matches.
7. IF the Report_Check fails on the first verification attempt, THEN THE Necromancer SHALL re-raise the Scribe once with the list of unbacked items.
8. IF the Report_Check fails a second time, THEN THE Necromancer SHALL drop "Scribe's reading" from the report.
9. WHEN the Report_Check finishes, THE Necromancer SHALL emit report.checked.
10. WHEN a Run reaches done, THE GitService SHALL export all.patch from the base sha to the Integration_Head.
11. WHEN a Run reaches done, THE Necromancer SHALL store the patch, the spec bundle, the report, events.ndjson, and the Death_Certificate once each with a sha256, and emit artifact.ready for each artifact.
12. WHEN a live-run artifact is requested, THE Necromancer SHALL serve the artifact from storage with the bytes and sha256 recorded at artifact.ready.
13. WHEN a Run reaches done, THE ExecutionBackend SHALL destroy every Box of the run.
14. WHEN the repository has no tests and the final_check build passes, THE Necromancer SHALL assign the outcome resurrected_build_only.
15. WHEN all artifacts are stored and every Box is destroyed in the done phase, THE Necromancer SHALL emit run.done.
16. WHEN the Reliquary displays the outcome partial, THE Reliquary SHALL show working and non-working items derived strictly from the before/after comparison table without model text.
17. IF the Report_Check fails a second time, THEN THE Reliquary SHALL show "The Scribe's narrative did not pass the evidence check and was left out."

### Requirement 27: Two-way messaging

**User Story:** As an invited user, I want to talk to the Necromancer and to each Skeleton while the run is going, so that I can steer the work and see that my message arrived.

#### Acceptance Criteria

1. WHEN a user sends a message, THE Necromancer SHALL store the message as an event in the EventStore and in the recipient Skeleton's mailbox.
2. WHEN a message is sent with delivery "After its current command", THE SkeletonSupervisor SHALL deliver the message by the correction method of Requirement 16 using _session/steer if advertised, or waiting for the current tool call to finish and sending a new prompt if _session/steer is not advertised.
3. WHEN a message is sent with delivery "Interrupt now", THE SkeletonSupervisor SHALL cancel the current turn at once with session/cancel and send the message as a new session/prompt.
4. WHEN the user chooses "Interrupt now" for message delivery, THE Legion_Dashboard SHALL warn that the running command's output will be lost.
5. WHEN updating message delivery state, THE Necromancer SHALL set the message state to Sent when stored, Delivered when steering is injected or the follow-up prompt is accepted, and Acknowledged when a Skeleton equipped with ack_message calls ack_message.
6. WHEN the user sends a message to a Skeleton, THE Necromancer SHALL copy the message to the Necromancer channel with cc: necromancer.
7. WHEN a Skeleton has made no tool call and written no log line for the silent-Skeleton limit, THE Necromancer SHALL send the Skeleton a nudge.
8. WHEN the user sends a message to the Necromancer, THE Necromancer SHALL accept only the intents instruct, revise_pact, priority, change_budget, pause_run, resume_run, stop_run, answer, approve, and deny.
9. WHEN the user sends a message to a Builder, THE Necromancer SHALL accept only the intents instruct, instruct_now, interrupt, re_raise, and lay_to_rest.
10. WHEN the user sends a message to the Warden, THE Necromancer SHALL accept only the intent add_review_focus.
11. WHEN the user sends a message to the Scribe, THE Necromancer SHALL accept only the intent instruct.
12. WHEN a Skeleton transmits a message to the Necromancer, THE Necromancer SHALL accept messages only through MCP_Gateway tools, and from the Warden only through warden_verdict.
13. WHEN a user message attempts to instruct any action that violates a Hard_Block, THE Necromancer SHALL reject the instruction.
14. WHEN a user message requests a budget change, THE Necromancer SHALL restrict any cap increase to at most the Code_Ceiling and the global ceiling.
15. WHEN a user message instructs the Warden to alter a Verdict, grant an approval, or access the Warden's checkout, THE Necromancer SHALL reject the instruction.
16. WHEN a Skeleton remains silent after a nudge and exceeds the silent-Skeleton limit without a pending tool call, THE SkeletonSupervisor SHALL send session/cancel and terminate the process.

### Requirement 28: Human-in-the-loop tiers and asks

**User Story:** As an invited user, I want to decide everything that changes scope, cost or safety, and to see the evidence behind the Necromancer's own decisions, so that I can trust the run.

#### Acceptance Criteria

1. WHEN an action affects scope, budget, or system safety (approving the Pact and every revision, confirming the budget, exceeding any cap, scope growth including a new task, a directory outside files scope or a new top-level dependency, executing any needs_approval command, deleting or disabling tests, or pushing to the Fork), THE Necromancer SHALL require an explicit user decision.
2. WHEN a task involves deleting or disabling tests, THE Necromancer SHALL allow deleting or disabling tests only through an approved Pact task that explicitly specifies it.
3. WHEN publishing a run to the History_Page, THE Necromancer SHALL require an explicit Admin action.
4. WHEN the Necromancer decides alone on Tier 2 actions (dispatch order and parallelism within the approved cap, re-dispatch while attempts remain, re-raise after a restart, answering an ask from the Pact or a cited file, splitting a task within the same files scope, acceptance command and budget, abandoning a task after the attempt limit, or choosing an evidence-backed option), THE Necromancer SHALL emit necromancer.decision with refs.
5. WHEN the UI renders a necromancer.decision event that carries no refs, THE UI SHALL show the decision with the tag "no evidence cited".
6. WHILE the Legion phase is running, THE Necromancer SHALL route answers to asks, task splits, and Pact revisions through the active Planner session.
7. WHEN an ask reaches its deadline unanswered, THE Necromancer SHALL apply the ask's default: approve_command denied; exceed_budget finish current tasks, then budget_stopped; plan_change skip, recorded as unaddressed; stuck_after_rejections skip; conflict_choice re-plan; ambiguity the evidence-backed candidate, naming it; nothing_to_do stop; push_confirm no push.
8. WHEN displaying an approval card, THE Legion_Dashboard SHALL show on every approval card the exact command, the working directory, the risk class, the reason, the requesting Skeleton, and the expiry time as text.
9. WHEN presenting an ask to the user, THE Necromancer SHALL offer only the design-defined options: for approve_command (Approve once, Approve this pattern for the run, Deny, Deny and lay to rest); for exceed_budget (Raise the cap up to the Code_Ceiling, Finish current tasks only, Stop now); for plan_change (Add it, Skip it, Stop); for stuck_after_rejections (Re-plan the task, Skip it, Stop the run); for conflict_choice (Prefer A, Prefer B, Let the Necromancer re-plan); for ambiguity (The candidates); for nothing_to_do (Plan anyway, Stop); and for push_confirm (Push, Do not push).
10. WHEN tracking the wait time for an approval ask, THE Necromancer SHALL enforce the expiration deadline using the approval wait Required_Setting.

### Requirement 29: Hard blocks and fork push

**User Story:** As the owner, I want writes to the original repository and other dangerous actions made impossible in code, so that no prompt or user can cause them.

#### Acceptance Criteria

1. WHERE GitHub write access is required, THE GitService SHALL hold the only GitHub write token in the system and expose exactly one GitHub write operation, pushToFork(runId).
2. WHEN pushToFork is called, THE GitService SHALL push only if the target repository is owned by the configured owner login and GitHub reports the target as a fork of the Source_Repository.
3. WHEN pushToFork is evaluated, THE GitService SHALL push only for a run whose Invite_Code has the push flag on and whose phase is done.
4. WHEN generating an Invite_Code, THE Admin_Page SHALL create every Invite_Code with the push flag off by default.
5. WHEN the user asks to push, THE Necromancer SHALL ask push_confirm for that push.
6. WHEN pushing to the Fork, THE GitService SHALL push only to a new branch named graveyard/<runId>.
7. WHEN interacting with GitHub, THE GitService SHALL perform no push, pull request, issue, or comment against the Source_Repository.
8. WHERE Git operations are exposed, THE GitService SHALL offer no force push and no branch deletion.
9. WHEN a push is requested and finished, THE Necromancer SHALL emit push.requested and push.result.
10. WHILE the system operates, THE Necromancer SHALL keep every Hard_Block in force whatever a prompt, an Invite_Code, a Necromancer decision, or a UI action asks.
11. WHEN evaluating a command, THE Command_Policy SHALL classify as blocked every argv that names the Kiro key, a GitHub token, an environment dump, ~/.ssh, or a cloud metadata address.
12. WHEN evaluating a command, THE Command_Policy SHALL classify as blocked every sudo command and every command that names a container socket or a host mount.
13. WHEN checking a Candidate diff, THE Necromancer SHALL refuse any diff that modifies files inside .kiro/ or .git/ within a worktree.
14. THE Necromancer SHALL meet Requirement 21.13.

### Requirement 30: Budgets and caps

**User Story:** As the owner, I want hard caps on time, tool calls and reported credits, so that no run spends more than allowed.

#### Acceptance Criteria

1. WHERE system caps are configured, THE Admin_Page SHALL expose every cap as an Admin setting.
2. IF any Required_Setting has no value, THEN THE Necromancer SHALL refuse to start runs.
3. WHERE default configurations are initialized, THE Necromancer SHALL ship these starting values as editable Admin settings: prompt wall-clock 10 minutes (Exhumer triage 3 minutes), 4 prompts per Skeleton, 60 tool calls per turn, context stop at 80 percent, run wall-clock 45 minutes, 3 Warden rejection rounds, silent-Skeleton limit 120 seconds, budget warning at 80 percent, queue depth 5, 4 live kiro-cli processes on the dev box, 1 parallel Soul-stitcher per run on the dev box, and live runs (dev 1, prod at most 5 under the default quota of 10 sandboxes, lowered by the global cap), and enumerate the Required_Settings without starting values (tool calls per run, credits per run and per day when credits are reported, approval wait, queue idle limit, Pact idle limit, repository size, and box resources).
4. WHILE a Skeleton executes a turn, THE BudgetGovernor SHALL check caps between tool calls.
5. WHEN a capped dimension reaches the budget warning level, THE BudgetGovernor SHALL emit budget.warning.
6. WHEN a capped dimension reaches 100 percent, THE BudgetGovernor SHALL emit budget.exceeded, let running Skeletons finish their current command, and ask the user exceed_budget.
7. WHEN budget.exceeded has been emitted for a run, THE Necromancer SHALL send no new session/prompt and start no new sandbox_exec in that run until a later event raises the cap within the Code_Ceiling.
8. WHEN a cap increase is requested, THE BudgetGovernor SHALL accept a cap increase only up to the Code_Ceiling and the global ceiling.
9. WHERE probe P5 shows a credit field in turn_completion, THE BudgetGovernor SHALL enforce credits per run and per day from skeleton.usage.credits.
10. WHERE probe P5 shows no credit field, THE BudgetGovernor SHALL cap runs by wall-clock and tool calls only.
11. WHERE credit metrics are evaluated, THE Necromancer SHALL compute no credit estimate.
12. WHEN tracking the run wall-clock duration, THE BudgetGovernor SHALL exclude Pact review and approval waits from the run wall-clock and report the excluded time separately.
13. WHEN a prompt reaches the prompt wall-clock cap, THE SkeletonSupervisor SHALL send session/cancel, wait up to 10 seconds for the prompt response, send SIGTERM, and send SIGKILL after 5 seconds.
14. WHEN a turn reaches the tool-call cap, THE SkeletonSupervisor SHALL send session/cancel.
15. WHEN a session's context usage reaches the context cap, THE SkeletonSupervisor SHALL steer the Skeleton to wrap up and then cancel the turn.
16. WHEN a Skeleton has used its prompts per Skeleton, THE SkeletonSupervisor SHALL refuse the next prompt.
17. WHERE the DockerCloudSandboxBackend is selected, THE BudgetGovernor SHALL count sandbox minutes toward the per-run cap.
18. WHEN the Admin changes a budget setting, THE Admin_Page SHALL record an audit entry.
19. WHEN Kiro API credits are exhausted, THE Necromancer SHALL send no new prompt and start no new command, let commands already running finish, end the run with outcome budget_stopped, keep the queue, and alert the Owner.
20. WHEN the first three Recorded_Runs conclude, THE Admin_Page SHALL require recalibration of the E11 settings (Warden rejection rounds, time caps, approval wait, silent-Skeleton limit, and queue idle limit).
21. WHEN total tool calls across all Skeletons in a run reach the tool calls per run setting, THE BudgetGovernor SHALL emit budget.exceeded.

### Requirement 31: Invite codes, admission, queue and concurrency

**User Story:** As the owner, I want live runs limited to people I invited and admitted in order, so that capacity and cost stay under my control.

#### Acceptance Criteria

1. WHEN an Invite_Code is generated, THE Admin_Page SHALL create Invite_Codes only for a signed-in Admin.
2. WHEN a run start is requested, THE Admission SHALL accept only Invite_Codes created through the Admin_Page.
3. WHEN storing an Invite_Code, THE Necromancer SHALL store every Invite_Code hashed, with expiry, allowed run count, Code_Ceiling caps, and push flag.
4. WHEN an Invite_Code is created, THE Admin_Page SHALL show the full Invite_Code only at creation.
5. WHEN Invite_Code verification is requested, THE Admission SHALL limit Invite_Code attempts per IP address.
6. WHEN a valid Invite_Code starts a run, THE Admission SHALL append the run to a FIFO queue and emit run.queued and run.queue_position.
7. WHEN a run reaches the head of the queue, THE Admission SHALL admit the run only when the Invite_Code is valid and under its run count, every Required_Setting has a value, the global concurrency cap has room, and the ExecutionBackend's capacity() reports a free slot.
8. IF the queue is at the queue depth cap, THEN THE Admission SHALL reject the start request with the reason.
9. IF a queued run stays idle past the queue idle limit, THEN THE Admission SHALL expire the queue entry.
10. WHILE the InstaboxDockerBackend is selected, THE Admission SHALL keep at most one live run.
11. WHILE the DockerCloudSandboxBackend is selected, THE Admission SHALL keep at most 5 live runs, or fewer when the global cap is lower.
12. WHILE a visitor has no Invite_Code, THE UI SHALL offer the autopsy and Replays of Recorded_Runs and disable Exhume with the reason.
13. WHEN a mutating route is requested, THE Necromancer SHALL check the Invite_Code or the Admin session and act only on the caller's own run.
14. WHEN the Admin removes, moves or cancels a queue entry, THE Admission SHALL apply the change and emit run.queue_position for every affected run.
15. WHEN the repository size reported by GitHub in its size metadata field exceeds the repository size cap setting, THE Admission SHALL reject the run request before cloning.
16. IF an authentication failure occurs on session initialization with Kiro, THEN THE Admission SHALL stop admitting runs, keep the queue, and alert the Owner.

### Requirement 32: Detached runs, event store and live stream

**User Story:** As an invited user, I want the run to keep going when I close the page and to resume the stream where I left off, so that minutes-long runs do not depend on my browser.

#### Acceptance Criteria

1. WHERE events are persisted for a run, THE EventStore SHALL keep one append-only event stream per run, keyed by (runId, seq), with seq gap-free per run and assigned inside the insert transaction.
2. WHERE event records exist in the database, THE EventStore SHALL never update or delete a stored event row.
3. WHEN the Admin redacts part of a run, THE EventStore SHALL append an admin.redaction event.
4. WHEN an event is stored, THE EventStore SHALL store every event with runId, seq, ts, kind, actor and data, and with skeletonId, taskId and attempt when they apply.
5. WHEN an event timestamp is recorded, THE Necromancer SHALL set every event ts from the Necromancer clock.
6. WHEN a client requests live events at GET /api/runs/{runId}/events, THE Necromancer SHALL serve live events as SSE with id equal to seq.
7. WHEN a client reconnects with Last-Event-ID, THE Necromancer SHALL replay the events from Last-Event-ID + 1 and then stream new events.
8. WHILE a run is in progress, THE Necromancer SHALL end a run only on Stop, a cap, or an Admin kill, so that closing the browser does not end the run.
9. WHEN the UI server or Necromancer restarts, THE Necromancer SHALL continue every live run whose sandboxes are re-attached using state reconciled from the RunStore, and terminate a live run with outcome error if its Box was lost.
10. WHEN exporting event history, THE Necromancer SHALL export events.ndjson from the same stored rows in the EventStore.
11. WHEN command output is produced, THE Necromancer SHALL store raw command output by logRef, redacted, and put only output tails into events.
12. WHEN a client requests event history over GET /api/runs/{runId}/events with from and to query parameters, THE Necromancer SHALL return the matching events as JSON in seq order.
13. WHEN any event is prepared for insertion, THE EventTap SHALL redact sensitive data from the event before the event is written to the EventStore.
14. WHEN the Necromancer serves events, THE Necromancer SHALL apply the redaction on the read path.

### Requirement 33: History and Replay of real runs

**User Story:** As a judge, I want to watch past runs exactly as they happened, so that I can trust that nothing shown was staged.

#### Acceptance Criteria

1. WHILE replaying a run, THE Replay_Page SHALL render exactly the stored events of the run in `seq` order, with no inserted or edited event.
2. IF a `seq` is missing from a stored event stream, THEN THE Replay_Page SHALL render a visible gap at that point.
3. WHILE listing runs, THE History_Page SHALL list a run only after an `admin.publish` event has been recorded for the run.
4. WHEN the Admin attempts to publish a run, THE Admin_Page SHALL allow publishing only after the Admin has reviewed the run and applied any redaction.
5. WHILE displaying runs, THE History_Page SHALL list failed, partial and cancelled runs with the same weight as successful runs and offer no "best of" filter.
6. WHEN loading the History_Page, the Replay_Page or a stored Reliquary, THE UI SHALL load the requested page with no live Skeleton and no Kiro access.
7. WHILE displaying a replayed run, THE Replay_Page SHALL show a persistent "Replay" banner and hide every run action button.
8. WHEN the Replay_Page reaches an `admin.redaction` point during playback, THE Replay_Page SHALL show "Redacted by the owner".
9. WHILE replaying a run, THE Replay_Page SHALL show both replay time and original time, and label every shortened wait.
10. WHEN the Admin hides a published run, THE History_Page SHALL show the run as "Removed by the owner".
11. WHEN the Replay_Page fetches events for a run, THE Replay_Page SHALL retrieve the stored events via `GET /api/runs/{runId}/events` with `from` and `to` query parameters as JSON.

### Requirement 34: Gate screen

**User Story:** As a visitor, I want the home page to explain the product and show honest live-run status, so that I know what I can do right now.

#### Acceptance Criteria

1. WHEN displaying the live-run status badge, THE Gate SHALL show the status from `GET /api/health` as one of "Live runs: open", "Live runs: queue is N long", "Live runs: paused by the owner" or "Live runs: unavailable", in text and icon.
2. WHILE the Necromancer runs in production mode, THE Gate SHALL show no "waking up" badge state.
3. WHILE the health check request to `GET /api/health` is loading, THE Gate SHALL show the badge text "Checking the crypt..." and keep the page usable.
4. WHEN displaying recent runs, THE Gate SHALL list recent Recorded_Runs retrieved from `GET /api/history?limit=`, each labelled "Recorded run" with repository, date and outcome.
5. WHEN no Recorded_Run exists in the response from `GET /api/history?limit=`, THE Gate SHALL show "No recorded runs yet."
6. WHEN a visitor submits an invalid repository URL, THE Gate SHALL show a message that names the accepted URL forms.
7. WHEN a submitted Invite_Code is wrong, expired, revoked or used up, THE Gate SHALL show a distinct message for each of the four cases.
8. WHILE live runs are paused or unavailable, THE Gate SHALL keep the autopsy working and explain why Exhume is disabled.
9. WHEN GitHub rate-limits the autopsy, THE Gate SHALL show the GitHub reset time.
10. WHILE displaying any Gate state, THE Gate SHALL show the footer line "Skeleton sessions run on Kiro CLI. Git-Graveyard is an independent project."
11. WHEN a visitor submits a valid repository URL and a valid Invite_Code, THE Gate SHALL submit the start request to `POST /api/start-run`.

### Requirement 35: Tombstone screen

**User Story:** As a visitor, I want the Tombstone to show the instant diagnosis and, with a code, the live Exhume, so that I see both what the rules say and what really fails.

#### Acceptance Criteria

1. WHILE the autopsy request is pending, THE Tombstone SHALL show a loading state without stage names.
2. WHEN the autopsy reports status `alive`, THE Tombstone SHALL show "still breathing" with the reasons checked.
3. WHEN the autopsy fails with `REPO_NOT_FOUND`, THE Tombstone SHALL show a not-found-or-private message.
4. WHEN the autopsy fails with `TOO_LARGE`, THE Tombstone SHALL show the size limit that was exceeded.
5. WHEN the autopsy fails with `LANGUAGE_UNKNOWN`, THE Tombstone SHALL name the files the Grimoire looked for.
6. WHEN the autopsy fails with `RATE_LIMITED`, THE Tombstone SHALL show the GitHub reset time.
7. WHEN some manifests cannot be read, THE Tombstone SHALL show a partial state that lists the unreadable manifests.
8. WHEN the autopsy completes, THE Tombstone SHALL show status, reasons, Last_Words, lifespan and years dead with `asOf`, stars and forks, languages and Signal_Chips.
9. WHILE no Exhume has started, THE Tombstone SHALL list what will run, the caps from the Invite_Code and the queue state before the Exhume button.
10. WHILE the visitor has no Invite_Code, THE Tombstone SHALL disable the Exhume button and offer a link to a Replay.
11. WHILE the run is queued, THE Tombstone SHALL show the waiting-room strip with the queue position.
12. WHILE Exhume is running, THE Tombstone SHALL show a row per command as the command starts, with command line, status, exit code, duration and "View output", plus the elapsed clock and Cancel.
13. WHEN the Death_Certificate shows failures, THE Tombstone SHALL show the Death_Certificate table and the button "Ask the Necromancer for a Pact".
14. WHEN install, build and tests all pass, THE Tombstone SHALL state that the repository installs, builds and passes its tests today and offer "Plan modernization anyway" and "Stop here".
15. WHEN the install fails, THE Tombstone SHALL show the install failure as the primary finding with build and test rows marked `Not run`.
16. WHEN no tests are found, THE Tombstone SHALL show "No tests found" in the test row with the rule that decided it.
17. WHEN Exhume hits an error, THE Tombstone SHALL show a plain-English message and "View output".
18. WHEN the Exhumer times out, THE Tombstone SHALL keep the completed rows and mark the rest `Not run: time limit`.
19. WHEN the user activates "Ask the Necromancer for a Pact", THE Tombstone SHALL navigate to the Pact_Screen for the run.

### Requirement 36: Pact screen

**User Story:** As an invited user, I want to read, edit and approve the Pact on one screen, so that I know exactly what the Legion will do before it starts.

#### Acceptance Criteria

1. WHILE the Planner is writing the Pact, THE Pact_Screen SHALL show "The Necromancer's Planner is writing the Pact" with the Necromancer channel visible.
2. WHEN the Planner finds nothing to change, THE Pact_Screen SHALL show the reason and a Stop button.
3. WHEN the Pact fails to parse or the Planner fails, THE Pact_Screen SHALL show the validation error in plain language with the buttons "Try again" and "Stop".
4. WHEN the coverage check lists uncovered failures, THE Pact_Screen SHALL show the failures under "Not addressed by any task".
5. WHILE the Planner is revising the Pact, THE Pact_Screen SHALL lock edits and, when the revision arrives, show the diff between versions.
6. WHILE the run is parked, THE Pact_Screen SHALL offer "Resume" and state that resuming clones the repository again.
7. WHEN the user approves the Pact, THE Pact_Screen SHALL open the Legion_Dashboard.
8. WHILE displaying the Pact tasks, THE Pact_Screen SHALL show the Warden final check, the Scribe report and the Grimoire_Gate as locked controls with the reason they cannot be removed.
9. WHEN an edit creates a dependency cycle, THE Pact_Screen SHALL reject the edit and name the cycle.
10. WHEN the user turns a task off, THE Pact_Screen SHALL flag every task that depends on the disabled task.
11. WHILE displaying budget settings, THE Pact_Screen SHALL show the budget caps from the Invite_Code as a ceiling that the user may lower.
12. WHERE Probe P5 shows no credit field in `turn_completion`, THE Pact_Screen SHALL state "Credits are not reported by the CLI; the cap is minutes and tool calls".
13. WHILE displaying budget terms, THE Pact_Screen SHALL state "The cap is checked between tool calls. A single tool call may finish after the cap is reached."
14. WHEN the user edits the Pact, THE Pact_Screen SHALL submit the changes to `POST /api/runs/[runId]/pact` to render the next `pactVersion`.

### Requirement 37: Legion dashboard and Run Header

**User Story:** As an invited user, I want to watch and steer every Skeleton on one screen, so that I can see what each one is doing and step in.

#### Acceptance Criteria

1. WHILE displaying any run page, THE Run_Header SHALL show the stage ribbon, a "Now" sentence from the latest `skeleton.tool_call`, the "You" slot, the clocks, the budget meters and the line "You can leave this page. The run keeps going."
2. WHILE the run is queued, THE Legion_Dashboard SHALL show one waiting-room card with position, number ahead, "Your place is kept", Cancel and a link to a Replay, and no empty Skeleton cards.
3. WHILE the run is starting, THE Legion_Dashboard SHALL show that the sandbox is being prepared and show the Exhumer card first.
4. WHILE an item needs the user, THE Legion_Dashboard SHALL show an inbox badge, fill the "You" slot and put the state in the tab title.
5. WHILE the SSE connection is down, THE Legion_Dashboard SHALL show "Reconnecting... showing events up to #<seq>" and resume from `Last-Event-ID`.
6. WHILE the Necromancer is recovering after a restart, THE Legion_Dashboard SHALL show the recovering state on the affected cards.
7. WHEN the run reaches `done`, THE Legion_Dashboard SHALL offer "Open the Reliquary" and keep the cards readable.
8. WHEN the run ends with a run-level error, THE Legion_Dashboard SHALL show a plain message and links to the kept evidence.
9. WHEN some tasks merged and others failed or were abandoned, THE Legion_Dashboard SHALL show the partial state.
10. WHILE displaying Skeleton cards, THE Legion_Dashboard SHALL show on every Skeleton card the role, task IDs, state as icon and text, attempt number, current tool call with its running time, log tail, elapsed time, credits or `not reported`, tool-call count and worktree name.
11. WHILE displaying cards for Skeletons, THE Legion_Dashboard SHALL offer Send instruction, Interrupt, Re-raise and Lay to rest on every Builder card, and Add review focus instead of Send instruction on the Warden card.
12. WHEN a card button is disabled and receives focus, THE Legion_Dashboard SHALL state why the button is disabled.
13. WHEN the user chooses Lay to rest, THE Legion_Dashboard SHALL ask for confirmation with the choices "Keep its commits" and "Discard its work".
14. WHILE displaying the Necromancer channel, THE Legion_Dashboard SHALL show the channel with filters for Decisions, Asks, Approvals and Messages, and show every decision with its evidence links.
15. WHILE displaying run controls, THE Legion_Dashboard SHALL offer Pause run, Resume and Stop run, require confirmation before Stop run, and offer Kill only to the Admin.
16. WHILE displaying tasks, THE Legion_Dashboard SHALL show the task graph with a task table view that carries the same data.
17. WHEN a Skeleton produces no tool call and no log line for the silent-Skeleton limit, THE Legion_Dashboard SHALL show "Silent for mm:ss" on that Skeleton card.

### Requirement 38: Reliquary screen

**User Story:** As an invited user, I want the results page to show what changed, what is proven and what is not, so that I can judge the outcome myself.

#### Acceptance Criteria

1. WHILE displaying the results page, THE Reliquary SHALL show an outcome banner from `run.done.outcome` in plain words.
2. WHEN displaying the outcome banner, THE Reliquary SHALL show the "Resurrected" banner only when both the final-check build and repository tests have passed.
3. WHEN the outcome is `partial`, THE Reliquary SHALL list what works and what does not from the before and after table.
4. WHILE displaying run verification, THE Reliquary SHALL show a before and after table with the rows Install, Build, Tests (repository's own), Grimoire signals, Lockfile and Runtime used, each cell with status, exit code, duration and "View output".
5. WHILE displaying the before and after table, THE Reliquary SHALL show tests added by Skeletons in a separate row, "Tests added by skeletons".
6. WHILE displaying code changes, THE Reliquary SHALL show a diff browser with each hunk tagged by task ID and Grimoire rule, using Monaco when Monaco loads and a plain `<pre>` view otherwise.
7. WHILE displaying tasks, THE Reliquary SHALL show a task ledger with each task's final state, attempts, Warden Verdict and reasons.
8. WHILE displaying artifacts, THE Reliquary SHALL offer downloads of `all.patch`, the spec bundle, the report, `events.ndjson` and the Death_Certificate, each with size and sha256.
9. WHILE displaying the run bundle, THE Reliquary SHALL show the Open in Kiro steps for the run's bundle.
10. WHILE artifacts are being assembled, THE Reliquary SHALL show "Packing the relics".
11. WHEN no task merged, THE Reliquary SHALL state that there is no diff and offer only the Death_Certificate and the report.
12. WHEN an artifact is missing, THE Reliquary SHALL show "This file could not be built. The event log is still available."
13. WHEN the Admin has hidden the run, THE Reliquary SHALL show "Removed by the owner".
14. WHERE the Invite_Code's push flag is on, THE Reliquary SHALL show the push target Fork and the branch `graveyard/<runId>` and state that the Source_Repository is not touched.
15. WHEN the Scribe's run report fails the Report_Check, THE Reliquary SHALL drop the unverified reading and state that the model reading failed verification.

### Requirement 39: History, Replay, Built with Kiro and Admin screens

**User Story:** As a visitor or the owner, I want every remaining screen to show each of its states clearly, so that no state looks like another.

#### Acceptance Criteria

1. WHEN no run has been published, THE History_Page SHALL show "No recorded runs have been published yet".
2. WHILE listing published runs, THE History_Page SHALL show on every row the repository, short base sha, date, outcome, wall time, roles used, before and after build status, recorded-on mode, engine version and the label "Recorded live run".
3. WHILE the History_Page is loading, THE History_Page SHALL show a loading state.
4. WHEN the Replay_Page reaches the last event during playback, THE Replay_Page SHALL show the ended state and offer the Reliquary.
5. WHEN the replayed run was killed, THE Replay_Page SHALL show the last stored event labelled as the point where the run was stopped.
6. IF the event log cannot be read, THEN THE Replay_Page SHALL show an error state.
7. WHEN a source file of a Built_With_Kiro_Page section is missing, THE Built_With_Kiro_Page SHALL show "None found" in that section.
8. WHILE no Admin is signed in, THE Admin_Page SHALL show only the sign-in state.
9. WHEN no Invite_Code exists, THE Admin_Page SHALL show the empty state.
10. WHILE displaying run controls, THE Admin_Page SHALL offer a kill switch with three levels (pause new runs, stop gracefully where running Skeletons end at their next tool boundary and worktrees are kept, hard kill), each behind a typed confirmation and stating how many runs the level affects.
11. WHILE managing finished runs, THE Admin_Page SHALL offer publish, redact and hide for finished runs.
12. THE Admin_Page SHALL meet Requirement 44.14.
13. WHEN rendering the Built_With_Kiro_Page, THE Built_With_Kiro_Page SHALL display evidence loaded from `kiro-evidence.json` and `GET /api/history?fields=kiro`.
14. IF a load error occurs, THEN THE History_Page SHALL show an error state with a plain message.

### Requirement 40: Honest metrics

**User Story:** As a judge, I want every number on screen to come from a recorded source, so that nothing is invented or estimated.

#### Acceptance Criteria

1. WHEN rendering any metric or numeral, THE UI SHALL render only numbers that map to a row of the Metric_Registry and equal the value computed from that row's source.
2. IF the source of a number is missing, THEN THE UI SHALL show `not available` with the reason, or `not reported` for credits, and display no estimate.
3. WHEN displaying any number, duration or pass/fail result, THE UI SHALL take no number and no pass or fail result from model output.
4. WHEN computing any duration, THE UI SHALL compute every duration from the Necromancer clock.
5. WHEN displaying test counts, THE UI SHALL show test counts only when parsed from a machine-readable runner report, and "Counts not available" otherwise.
6. WHEN determining the status of install, build and test commands, THE UI SHALL derive the status of install, build and test only from the command's exit code, `timedOut` flag, and `oomKilled` flag.
7. WHEN an earlier step fails or a script does not exist, THE UI SHALL show a step as `not run`.
8. WHILE rendering any screen, THE UI SHALL show no score, health percentage or confidence percentage.
9. WHILE rendering text on any screen, THE UI SHALL contain none of the claims "X% faster", "hours saved", "production ready", "safe", that a Skeleton "understood" something, or that the app is a Kiro product.
10. WHEN displaying duration estimates, THE UI SHALL show "Runs like this took between X and Y" with X the shortest and Y the longest recorded wall time only when at least 3 comparable published runs exist, defined by Metric_Registry row M25, or as published runs with the same recorded-on mode when M25 gives no rule, and "No estimate yet" otherwise.
11. WHEN displaying queue status, THE UI SHALL show the queue position without a time estimate.
12. WHILE Spike S3 has not recorded the npm deprecation warning line format, THE UI SHALL show the deprecation warning count as `not available`.
13. WHEN displaying any GitHub-derived number, THE UI SHALL show every GitHub-derived number with its `asOf` date.
14. WHEN displaying the Kiro CLI version, THE UI SHALL show the Kiro CLI version only from a recorded version command result.
15. WHERE Probe P5 shows no credit field in `turn_completion`, THE UI SHALL show credits as `not reported` and provide no credit estimate.

### Requirement 41: Failure handling

**User Story:** As an invited user, I want every failure to give a defined outcome with the evidence kept, so that a broken run still tells me what happened.

#### Acceptance Criteria

1. IF repository installation still fails after the Legion phase, THEN THE Necromancer SHALL end the run with outcome not_resurrected.
2. WHEN the Source_Repository has no tests, THE Warden SHALL verify the candidate by executing install, build, and any lint or typecheck commands present in the repository.
3. WHEN the Source_Repository has no tests and the final-check install and build pass, THE Necromancer SHALL end the run with outcome resurrected_build_only.
4. WHEN a task is skipped after reaching the Warden rejection rounds limit, THE Necromancer SHALL continue dispatching the remaining tasks in the Pact.
5. IF a kiro-cli process exits unexpectedly or breaks its communication pipe, THEN THE Necromancer SHALL mark the Skeleton failed and preserve its worktree and log.
6. WHEN a crashed Skeleton is respawned, THE Legion_Dashboard SHALL show "Recovering", followed by "Resumed the same session" or "Restarted from its last commit".
7. WHEN the Necromancer restarts, THE Necromancer SHALL read the RunStore, list Boxes by run label via the ExecutionBackend, kill orphaned kiro-cli processes using pidfiles, destroy orphaned Boxes, and resume or fail each run.
8. WHEN the Necromancer restarts, THE Necromancer SHALL emit a system.worker_restart event and pause the run clock for every affected run.
9. IF a run's Box is lost during a restart, THEN THE Necromancer SHALL end the run with outcome error while preserving all collected evidence.
10. IF GitHub returns HTTP status 403 or 429 with x-ratelimit-remaining: 0 or a retry-after header, THEN THE Necromancer SHALL disable autopsy and fork push operations until the reset time and allow already cloned runs to continue.
11. WHILE the DockerCloudSandboxBackend reports no available capacity, THE Admission SHALL keep runs queued with reason capacity.
12. WHEN no session/update arrives within the silent-Skeleton limit while no tool call is pending, THE SkeletonSupervisor SHALL send a nudge message, and only issue session/cancel and terminate the Skeleton process if silence persists after the nudge.
13. IF an ACP initialize request asks for login credentials or session/new returns an authentication error, THEN THE Admission SHALL stop admitting runs, preserve the queue, and alert the Owner without entering a retry loop.
14. WHILE Admission is stopped due to an authentication failure, THE Gate SHALL display "Live runs: unavailable".
15. IF Kiro reports a rate limit error, THEN THE Admission SHALL pause the queue, apply exponential backoff with jitter, and halve admitted concurrency.
16. IF Kiro reports that credits are exhausted, THEN THE Necromancer SHALL send no new prompt and start no new command, let commands already running finish, end the run with outcome budget_stopped, keep the queue, and alert the Owner.
17. IF a Box is killed due to out-of-memory, exits unexpectedly, or reaches its TTL, THEN THE Necromancer SHALL collect Box logs, recreate the Box once, and rerun only the command that failed.
18. WHEN a command terminates due to out-of-memory or timeout, THE UI SHALL display oomKilled or timedOut on the command row.
19. IF a secret is detected in a Candidate diff or inside a Box, THEN THE Necromancer SHALL quarantine the worktree, fail the task, and alert the Owner.
20. IF the active model of a Skeleton does not match the role's allowed model tier at session start, THEN THE SkeletonSupervisor SHALL mark the Skeleton failed with reason model_mismatch before any prompt is sent.
21. IF the MCP_Gateway is not connected to a Skeleton at session start, THEN THE SkeletonSupervisor SHALL mark the Skeleton failed with reason gateway_missing before any prompt is sent.
22. IF a symlink escape outside the worktree root is detected during the scan before a prompt or after a sandbox_exec, THEN THE Necromancer SHALL terminate the Skeleton, quarantine the worktree, and fail the run with outcome error.
23. IF a pending permission request in the PermissionBroker exceeds the broker watchdog timeout, THEN THE PermissionBroker SHALL reject the request with reject_once, log a Necromancer bug, and emit permission.anomaly.
24. WHEN respawning a crashed Skeleton, THE Necromancer SHALL respawn the Skeleton once using session/load with its existing KIRO_HOME and continue from the current tree state without resending the lost prompt.
25. IF repository installation still fails after the Legion phase, THEN THE Reliquary SHALL show the baseline Death_Certificate errors and new installation errors side by side.

### Requirement 42: Redaction and secrets

**User Story:** As the owner, I want every secret kept out of boxes, logs, events and artifacts, so that publishing a run or a repository leaks nothing.

#### Acceptance Criteria

1. WHEN an event or log is emitted, THE Redactor SHALL redact the event or log before the event or log is stored in the EventStore or written to disk.
2. WHEN redacting events and logs, THE Redactor SHALL replace the exact value of every secret held by the Necromancer, including the Kiro API key, GitHub tokens, the Docker PAT, the admin secret, and Invite_Codes.
3. WHEN redacting events and logs, THE Redactor SHALL replace every string matching the patterns ksk_, ghp_, github_pat_, dckr_pat_, AKIA, or -----BEGIN.
4. WHEN redacting events and logs, THE Redactor SHALL replace host details, including Box addresses and local filesystem paths such as /data/home and C:\Users.
5. WHEN a sandbox_exec is about to run or a Candidate diff is submitted to the Grimoire_Gate, THE Necromancer SHALL scan the changed worktree files or diff using the secret redaction rules and quarantine the worktree on a hit.
6. WHEN executing the CI_Pipeline, THE CI_Pipeline SHALL run a canary test planting canary tokens in a repository file, a command output, and a tool result, and pass only when no canary token appears downstream of the EventTap or in any artifact.
7. WHERE the Kiro API key is stored, THE Necromancer SHALL keep the key only in one secret file readable by the necro user in development or the host secret store in production, in Necromancer memory, and in the environment of kiro-cli child processes.
8. WHERE Boxes are created by either ExecutionBackend, THE Necromancer SHALL keep the Kiro API key value out of the Box environment, every Box file, every stored event, every command log, and every artifact.
9. WHERE live runs are configured, THE Necromancer SHALL use separate Kiro API keys for development and production environments.
10. WHERE GitHub tokens are managed, THE GitService SHALL hold the tokens.
11. WHERE the Docker PAT is stored, THE Necromancer SHALL keep the Docker PAT only in the production host secret store and out of the dev box and Boxes.
12. WHERE the admin secret is configured, THE Necromancer SHALL keep the admin secret out of the UI client bundle and out of logs.
13. WHERE the dev box SSH address is referenced, THE Necromancer SHALL keep the dev box SSH address out of the repository, documentation, and stored events.
14. WHILE the Kiro content-use opt-out has not been set, THE Necromancer SHALL refuse to start any live run.
15. WHEN publishing runs to the History_Page or Replay_Page, THE Admin SHALL review and redact the run data before publication.
16. THE Necromancer SHALL meet Requirement 22.3.
17. WHERE the Instabox API key is used, THE Owner SHALL store the key only on the Owner's local machine.
18. WHERE network access is configured for kiro-cli processes, THE Necromancer SHALL restrict outbound traffic for the skel user to the allowed Kiro hosts and the loopback MCP_Gateway via host firewall rules.
19. WHERE GitHub tokens are managed, THE Necromancer SHALL keep the tokens out of Skeleton environments, Boxes, and logs.
20. WHERE the Instabox API key is used, THE Necromancer SHALL keep the key out of Boxes and the repository.

### Requirement 43: ExecutionBackend

**User Story:** As the owner, I want one sandbox interface with a development and a production implementation, so that promotion changes configuration and credentials, not code.

#### Acceptance Criteria

1. WHEN initializing the execution layer, THE Necromancer SHALL select the ExecutionBackend implementation from the configuration value EXECUTION_BACKEND, set to either instabox-docker or docker-cloud-sandbox.
2. WHEN receiving a command execution request, THE ExecutionBackend SHALL accept commands only as argv arrays and reject shell command strings.
3. IF a Box spec carries a secret value or a non-empty secrets or ports field, THEN THE ExecutionBackend SHALL reject the spec.
4. IF a Box spec contains an environment variable name or value matching the secret denylist in env, THEN THE ExecutionBackend SHALL reject the spec.
5. WHEN create is called with an idempotency key matching an existing Box, THE ExecutionBackend SHALL return the existing Box.
6. WHEN streaming command output from a Box, THE ExecutionBackend SHALL number output chunks in sequence and resume output from a requested sequence number.
7. IF a Box spec sets user ID 0, THEN THE ExecutionBackend SHALL reject the spec.
8. WHEN creating a Box, THE ExecutionBackend SHALL configure networking with default deny and an allowlist of exact host names.
9. WHEN the Necromancer restarts, THE ExecutionBackend SHALL re-attach existing Boxes through get and list them by labels through list.
10. WHERE the InstaboxDockerBackend provisions workspaces, THE InstaboxDockerBackend SHALL bind-mount only builders/ into the Runbox and only warden/ into the Auditbox.
11. WHERE the InstaboxDockerBackend configures container networking, THE InstaboxDockerBackend SHALL assign each run an internal network whose only exit is the allowlist CONNECT proxy.
12. WHERE the DockerCloudSandboxBackend executes in production, THE DockerCloudSandboxBackend SHALL use Topology_P-B, running kiro-cli on the production host and moving files through syncIn and syncOut.
13. IF probe P10 or probe P11 lacks a recorded pass, THEN THE Necromancer SHALL enforce Topology_P-B.
14. WHEN syncOut executes, THE DockerCloudSandboxBackend SHALL reject absolute paths, .. segments, paths under .git/ or .kiro/, symlinks, and files exceeding the size limit.
15. WHEN syncOut executes, THE DockerCloudSandboxBackend SHALL exclude build outputs including node_modules and dist, and include sources, manifests, and lock files.
16. WHILE managing workspace files under Topology_P-B, THE DockerCloudSandboxBackend SHALL maintain the host worktree as the authoritative source of truth for model edits.
17. WHEN a production run finishes, THE DockerCloudSandboxBackend SHALL pull artifacts and logs before destroying the sandboxes.
18. THE ExecutionBackend SHALL create no snapshots of any sandbox.
19. WHILE the live run system operates, THE Necromancer SHALL run outside every cloud sandbox.
20. IF probe P16 shows that the production SDK does not separate stderr, THEN THE DockerCloudSandboxBackend SHALL report separateStderr: false and log output as a single merged stream.
21. WHERE sandboxes are provisioned under DockerCloudSandboxBackend, THE DockerCloudSandboxBackend SHALL enforce a default lifetime TTL of 1 hour with a renewable hard cap of 24 hours.
22. WHERE sandboxes are provisioned in production, THE ExecutionBackend SHALL limit admitted concurrency to at most 5 concurrent runs based on the 10-sandbox account quota.

### Requirement 44: Promotion gate

**User Story:** As the owner, I want production to exist only after a signed security audit, so that the public deployment is no weaker than reviewed.

#### Acceptance Criteria

1. WHILE the pre-promotion Security_Access_Audit has not passed, THE Promotion_Gate SHALL allow no production credential to be created and no production URL to be published.
2. WHEN conducting the Security_Access_Audit, THE Promotion_Gate SHALL cover every audit block of wp-c C11 plus items XR-01, XR-02, and XR-03.
3. WHEN concluding each item of the Security_Access_Audit, THE Promotion_Gate SHALL require the item to end as Pass or Accepted risk with the Owner signature.
4. IF an audit item of severity B is accepted as a risk, THEN THE Promotion_Gate SHALL require a written rationale recorded in the audit evidence.
5. WHEN executing the audit procedure, THE Promotion_Gate SHALL run the Security_Access_Audit twice: once before promotion and once after promotion, with the second run executing items marked post.
6. WHEN storing audit evidence, THE Promotion_Gate SHALL save records in 01_evidence/audit-<date>/ with exactly one file per item ID.
7. WHEN executing the repository-going-public block RP, THE Promotion_Gate SHALL run the opensource-privacy-audit skill and attach the skill report to the evidence.
8. WHEN verifying production credentials, THE Promotion_Gate SHALL verify that all production credentials are created fresh and differ from every development credential.
9. WHEN promotion completes, THE Promotion_Gate SHALL verify that the development Kiro key, Instabox key, dev Invite_Codes, and development GitHub tokens are revoked, and that the post-promotion audit verifies the old values fail.
10. WHEN evaluating item XR-01, THE Promotion_Gate SHALL verify that every Box of a finished run is destroyed and no residual state carries over to subsequent runs.
11. WHEN evaluating item XR-02, THE Promotion_Gate SHALL verify that the kill switch functions successfully at all three design levels.
12. WHEN evaluating item XR-03, THE Promotion_Gate SHALL verify that any push to a non-fork repository and any write operation to the Source_Repository are refused.
13. WHERE tracking promotion readiness, THE Promotion_Gate SHALL track audit completion under memory task T8 as a prerequisite to production launch.
14. WHILE a signed pre-promotion Security_Access_Audit record is not present, THE Admin_Page SHALL block switching the Necromancer to production mode.

### Requirement 45: Phase 0 probes

**User Story:** As the owner, I want every unverified platform fact probed before live runs are enabled, so that the system never relies on a guess.

#### Acceptance Criteria

1. WHERE a Probe or Spike lacks a recorded result in memory/RUNS.md, THE Necromancer SHALL treat that Probe or Spike as not passed.
2. WHILE any of the probes P1 to P9, P12 to P15, or spikes S1 to S5 lacks a recorded result, THE Necromancer SHALL keep live runs disabled, except that a recorded real failure (exit code 1, not an inconclusive exit code 2) of probe P2, P4, P5, or P9 counts as a recorded result once its fallback is implemented and the gate reports it as settled by fallback.
3. WHILE any of the probes P10, P11, P16, and P17 lacks a recorded result, THE Necromancer SHALL keep production live runs disabled.
4. WHEN executing a Probe or Spike, THE Phase_0_Runbook SHALL record each result as one line in memory/RUNS.md and store the raw transcript in 01_evidence/phase0-<date>/<id>/.
5. WHEN preparing the dev box for probe execution, THE Phase_0_Runbook SHALL check uname -m and ldd --version, install kiro-cli 3.1.0 with its sha256 checksum verified, configure the root-owned KIRO_DEFAULT_SETTINGS file, and use only the dev Kiro key before running any probe.
6. IF probe P4 shows that agents are not read from $KIRO_HOME/agents, THEN THE Necromancer SHALL provide each Skeleton with an isolated HOME directory so that ~/.kiro/agents/ resolves per Skeleton.
7. IF probe P6 shows that the designed ask or deny rules do not behave as designed, THEN THE Necromancer SHALL use the documented-safe permission form by allowing the explicit path, directing all other actions to ask, and having the PermissionBroker reject them.
8. IF probe P8 or spike S4 shows that parallel sessions exceed host capacity, THEN THE Admission SHALL limit live execution to one Skeleton at a time.
9. IF probe P9 shows that bwrap does not work, THEN THE Necromancer SHALL keep Kiro's internal sandbox disabled and spawn the stdio shim with an explicit environment.
10. WHERE probe P12 shows that file tools follow symlinks, THE Necromancer SHALL enforce a mandatory symlink scan before every prompt and after every sandbox_exec.
11. IF probe P15 shows that _kiro/account/getUsage is not advertised, THEN THE Admin_Page SHALL direct the Owner to the Kiro portal for the credit balance.
12. IF probe P15 shows that no MCP status method is advertised, THEN THE SkeletonSupervisor SHALL verify Skeleton connection status using the MCP_Gateway's own connection record.
13. IF probe P13 shows that auto-pause kills a live run on the dev box, THEN THE Phase_0_Runbook SHALL require the operator to keep an active session open during recordings.
14. IF spike S5 shows that an incoming request cannot wake the paused dev box, THEN THE Phase_0_Runbook SHALL require the operator to wake the box manually before use.
15. IF probe P1 fails to operate headlessly using only KIRO_API_KEY, THEN THE Necromancer SHALL activate the Headless_Fallback channel.
16. THE Necromancer SHALL meet Requirement 30.10.
17. THE Necromancer SHALL meet Requirement 22.11.
18. IF probe P14 shows that the stream-json output cannot report the verified active model, THEN THE Necromancer SHALL keep the Headless_Fallback channel disabled for live runs.

### Requirement 46: Accessibility

**User Story:** As a user of a keyboard or a screen reader, I want every screen to be usable without a mouse or colour vision, so that I can follow and steer a run.

#### Acceptance Criteria

1. WHEN the end-to-end tests run, THE UI SHALL produce no axe violation of impact serious or critical on any page.
2. WHEN rendering page structure, THE UI SHALL mark header, main, and complementary landmarks on every page and provide a skip link to the "Needs you" section.
3. WHEN navigating by keyboard, THE UI SHALL make every action reachable using the Tab key and make task graph nodes reachable as a roving-tabindex list.
4. WHEN live events arrive, THE UI SHALL preserve keyboard focus in its current element.
5. WHEN a dialog opens, THE UI SHALL trap focus inside the dialog and return focus to the opening control when the dialog closes.
6. WHEN state changes occur, THE UI SHALL announce non-fatal state changes in a polite live region and use an assertive live region only for errors that stop the run or for a kill action.
7. WHEN rendering the log tail, THE UI SHALL set role="log" and aria-live="off" by default, and provide an "Announce new log lines" toggle control.
8. WHEN updating elapsed time and credit counters, THE UI SHALL keep elapsed and credit counters outside of aria-live regions.
9. WHILE prefers-reduced-motion is active, THE UI SHALL disable fog drift, candle flicker, graph glow, and scroll animations.
10. WHEN conveying status or state, THE UI SHALL convey every state using an icon and text in addition to colour.
11. WHEN displaying text and controls, THE UI SHALL meet WCAG AA contrast with body text contrast of at least 4.5:1 on #0a0a0c and use accent purple only for borders and icons.
12. WHEN a timed control approaches expiration, THE UI SHALL show the deadline as text and display an advance warning before expiry.
13. WHEN rendering Skeleton cards, THE UI SHALL assign each Skeleton card an accessible name containing its role, number, state, and attempt.
14. WHERE keyboard shortcuts are configured, THE UI SHALL allow the user to disable every keyboard shortcut.
15. WHEN rendering console log lines, THE UI SHALL attach data-rule and data-file attributes to each line DOM node.
16. WHERE a graphical Monaco diff viewer cannot be rendered, THE UI SHALL provide a semantic pre element fallback.
17. WHILE prefers-reduced-motion is active, THE Replay_Page SHALL step through graph changes without animation.

### Requirement 47: English-only UI text

**User Story:** As a judge, I want all interface text in plain English, so that the submission meets the contest's English-materials rule and stays readable.

#### Acceptance Criteria

1. THE UI SHALL render all user-facing text in English.
2. WHERE the gothic voice is used, THE UI SHALL restrict the gothic voice to headings and empty states.
3. WHEN displaying error messages, THE UI SHALL write every message in plain words that state what action to take next.
4. WHEN any gothic term (Necromancer, Skeleton, Grimoire, Pact, Death_Certificate, Legion, Reliquary, Lay_to_rest) appears for the first time on a page, THE UI SHALL display the term with a plain-English gloss.
5. WHEN describing Kiro's role in live runs, THE UI SHALL describe Kiro's role using only the exact wording "Skeleton sessions run on Kiro CLI."
6. WHERE footer text describing Kiro is rendered, THE Gate SHALL include the statement "Git-Graveyard is an independent project." following the Kiro role description.

### Requirement 48: Build-time Kiro evidence

**User Story:** As a judge, I want proof of how Kiro was used to build and run the project, generated from real files and run records, so that the claim can be checked.

#### Acceptance Criteria

1. WHERE build-time Kiro hooks are configured, THE Project_Hooks SHALL be stored in .kiro/hooks/*.json adhering to the schema {"version":"v1","hooks":[...]}.
2. WHEN an agent saves a file matching lib/rules/.*\.ts$, THE Project_Hooks SHALL execute a PostFileSave action running npm run test:props.
3. WHEN a spec task finishes execution, THE Project_Hooks SHALL execute a PostTaskExec action running npm run test:golden.
4. WHEN an agent write tool targets a path under test/golden/, .kiro/specs/resurrection/, 01_evidence/fixtures/, or .cache/, THE Project_Hooks SHALL block the write action with exit code 2.
5. WHEN generating build evidence, THE Evidence_Builder SHALL write kiro-evidence.json listing only verified existing files: specs, steering files with their inclusion mode, hooks with their trigger, custom agents, and spec-to-task-to-commit links derived from git log.
6. WHEN executing the CI_Pipeline, THE CI_Pipeline SHALL verify that every file path listed in kiro-evidence.json exists in the repository.
7. WHEN rendering build-time evidence, THE Built_With_Kiro_Page SHALL render the evidence sourced from kiro-evidence.json.
8. WHEN displaying published run records, THE Built_With_Kiro_Page SHALL render, for the three most recent published runs, each Skeleton's role, agent name, model ID, kiro-cli version, session ID, and timestamp from run.started and skeleton.raised events.
9. WHEN rendering agent capabilities, THE Built_With_Kiro_Page SHALL list the committed role agent templates along with their configured tool permissions.
10. WHEN presenting architecture boundaries, THE Built_With_Kiro_Page SHALL identify the Grimoire autopsy path under the section "What does not use Kiro".
11. WHEN displaying handoff instructions, THE Reliquary SHALL instruct the user to execute git apply -p1 all.patch on a clone at the pinned sha, followed by copying spec/ to .kiro/specs/resurrection/<owner>-<repo>/.
12. IF unknown U14 shows that Kiro does not list nested spec folders, THEN THE Reliquary SHALL provide .kiro/specs/<owner>-<repo>/ as the spec copy target directory.
13. WHERE an agent write tool targets .agent-ws/ or script-baked output directories, THE Project_Hooks SHALL allow the write action without blocking.
14. WHEN a PostFileSave or PostTaskExec hook command fails with a non-zero exit code, THE Project_Hooks SHALL deliver stderr to the agent without blocking the action.
