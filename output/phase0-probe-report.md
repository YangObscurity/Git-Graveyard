# Phase 0 probe report - dev-sandbox, 2026-11-10/11

Run: `scripts/phase0/runner.ts` against an isolated Linux dev sandbox host.
Archived local evidence paths and internal run logs are omitted from the public tree.

## Authentication path (applies to every probe)

`KIRO_API_KEY` does not exist for this account; the owner cannot issue one. The
ACP `initialize` response advertises only two auth methods,
`aws-builder-id` and `aws-iam-identity-center`, and `kiro-cli acp` resolves the
token itself (`--auth-method cli`, the default) from the CLI login session.
Every probe therefore ran with `AUTH: cli-login`, recorded in its stdout, and
P1's original question ("headless with only `KIRO_API_KEY`") stays untested on
the key path.

## Results

| ID | Result | What the evidence says |
|---|---|---|
| P1 | PASS | `kiro-cli acp --agent-engine=v3` completes initialize, `session/new` and `session/prompt` headless with the CLI login. `session/new` rejects a request without `mcpServers` (`-32602 Invalid params`) |
| P2 | FAIL (real) | The session used Kiro's built-in tools; the client's `fs/*` and `terminal/*` capabilities were not called. Design B stays |
| P3 | PASS | `session/new` accepts an HTTP MCP server entry; the tool is selected; the request timeout is accepted |
| P4 | FAIL (real) | Agents are not read from `$KIRO_HOME/agents`; `kiro-cli` ignores `KIRO_HOME` (whoami still works with a bogus value). Fallback: give each skeleton its own HOME |
| P5 | FAIL (real) | `turn_completion` carries no credit or cost field. Caps must use wall clock and tool calls; the UI shows "not reported" |
| P6 | PASS | Two `session/request_permission` requests were captured, and the tool outcomes line up with the rules. **B7:** the request carries only `sessionId`, `toolCall` and `options` plus `_meta.kiro` (`toolId`, `consent.capability/resource/askType/matchedRule/scope/source/workspaceRoot`, `consentRound`) — there is **no `decision` field, so an agent cannot supply the verdict**. **B8:** option ids are unique within a request (`accept, reject, always-reject` for the rule-driven read; `accept, always-accept, reject, always-reject` for the write), so no duplicate-id case appeared. Rules: `deny` raised no request and the write failed; `ask` raised a request and, answered with `{outcome:{outcome:"selected",optionId:"accept"}}`, the read completed. Note: the allowed write reported `completed` but the file was not on disk after the session was killed, so the probe's file check is informational, not a verdict |
| P7 | PASS (weak) | In one turn the model reported no repo `.kiro` agents, steering, hooks, `mcp.json` or `AGENTS.md`. Model-reported, not tool-verified |
| P8 | PASS | Four parallel `kiro-cli acp` processes ran: RSS about 351 MB each, 15.5 s to the last session |
| P9 | FAIL (real) | `bwrap` is not installed, so the in-engine sandbox cannot be relied on. Fallback: sandbox off, spawn the shim with an explicit environment |
| P10 | INCONCLUSIVE | Docker runs containers, but container-to-Kiro proxy injection was not exercised. Topology P-B is already chosen, so nothing changes |
| P11 | INCONCLUSIVE | No key ever leaves `kiro-cli`; there is no header to inspect. P-B unaffected |
| P12 | INCONCLUSIVE | `/proc/mounts` shows `nosymfollow`; whether Kiro's file tools follow a symlink out of the workspace was not exercised, so requirement 22.8 keeps the mandatory scan |
| P13 | PASS | Auto-pause did not kill the live run: a 1734 s pause was observed (heartbeat gap), `boot_id` unchanged, the heartbeat process resumed on the same PID, and the container was still `running`. `/proc/uptime` lost about 30 min against the wall clock, which matches the pause. The platform agrees: idle suspend at 00:26:00Z, `runtime.processesPreserved: true` |
| P14 | PASS | `chat --v3 --no-interactive --output-format stream-json` works and reports the active model |
| P15 | PASS | The advertised `_kiro/*` methods are recorded verbatim (memory, code intelligence, session context/compact/export/history, configuration, workflow, source providers) |
| P16 | PASS | Docker keeps stdout and stderr separate in a non-pty run |
| P17 | INCONCLUSIVE | Needs the cloud sandbox product; not reachable from this box |
| S1 | PASS | `stream-json` reports credits per update: `_meta.kiro.credits = [{usage: 0.1168, unit: "credit"}]`. Context token counters are separate fields. Caps can be enforced from the credit field |
| S2 | INCONCLUSIVE | `--resume-id` continues the session with its context; the `PreToolUse` hook half and the shell tool id were not exercised |
| S3 | PASS | The pinned fixture repos parse and diff offline |
| S4 | PASS | 4 vCPU and 8 GB; enough for one session plus a Node build, and for parallel sessions with the P8 numbers |
| S5 | PASS | The first request after an idle suspend woke the box in 4114 ms (bound 45 s). Platform records agree: `trigger: idle` suspend at 01:33:13Z, `runStartedAt` 01:40:18Z, and the heartbeat gap across the pause was 427 s |

## Runbook consequence

The target remote sandbox enforces an idle auto-suspend window (~30 minutes) and a
bounded single-session runtime cap. In the S5 probe window, waking from idle suspend
completed normally with first-request latency around ~4.1 s (`4114 ms`).

A paused sandbox resumes on the next request, so a recording only has to survive the
pause, not avoid it. If a silent stretch (a long model call) must not be paused,
hold an activity lease (30-3600 s via the sandbox provider's lease API) instead of
polling the box: polling resets the idle timer and hides the pause. Keep a single
run under the session runtime cap, and note that a runtime pause blocks waking
during its cooldown.

## Consequences for the design

### Wired into the code (2026-11-11)

- **P6 / client duties.** `AcpClient` now answers `_kiro/terminal/shell_type`
  (`{shellType: "bash"}`) and other `_kiro/*` client requests; anything else,
  including `fs/*` and `terminal/*`, still gets `-32601`. `AcpTransport` gained a
  method-aware fallback handler. Before this, kiro-cli stalled before the first
  tool call, which is why P6 could not reach a permission request.
- **P4 / per-Skeleton HOME.** `provisionSkeletonEnvironment` writes the agent and
  `settings.json` under `$HOME/.kiro/` as well as `$KIRO_HOME/`, because 3.1.0
  ignores `KIRO_HOME`. Agent templates are now looked up as `.json` first.
- **P5 / caps in code.** `BudgetCapTracker` counts wall clock, tool calls and
  (when the stream reports them) credits; `SkeletonSupervisor` cancels on the
  first cap and emits `budget_exceeded`. A credit cap stays inert until the
  stream reports credits, which S1 showed it does.
- **P9 / no in-engine sandbox.** The Skeleton child is spawned with exactly
  `HOME`, `KIRO_HOME`, `KIRO_API_KEY`, `PATH` and the plain `acp --agent-engine=v3`
  arguments, asserted by test.
- **P2 / Design B.** The client advertises no `fs` or `terminal` capability at
  `initialize`, asserted by test.

Tests: `test/supervisor/probe-t39.test.ts` (11 cases). Supervisor suite before
and after the change: 35 tests / 25 pass / 10 fail → 46 / 36 / 10, so the 10
failures are pre-existing and no test regressed.

- **Credits are visible** (`_meta.kiro.credits` per update), so the M22 cap can
  read a real number instead of "not reported". P5's FAIL only covers
  `turn_completion`, which is a different record.
- **`KIRO_HOME` is inert**; agent isolation has to be per-process HOME, and the
  agent config is JSON under `<workspace>/.kiro/agents/`, not markdown. A CRLF
  JSON file is rejected by the loader even though the JSON itself is valid.
- **`session/new` needs `mcpServers`** (an explicit `[]` is fine) and the client
  must answer `_kiro/terminal/shell_type`, otherwise the session stalls before
  any tool call. This is a production requirement for the ACP client, not just
  a probe detail.
- **No `bwrap`**: keep the in-engine sandbox off and sanitise the shim's
  environment.
- **B7 is closed, B8 stays defensive.** Kiro's permission request has no field a
  builder could use to supply a verdict (only `sessionId`, `toolCall`, `options`
  and `_meta.kiro`), so the broker must keep deciding on its own and must keep
  ignoring any look-alike field. `optionId` values were unique in both observed
  requests, so duplicate-id handling is unproven by the probe and must stay a
  guard (cancel and record) rather than a path that trusts the id.
- **The answer envelope matters.** The permission answer must be
  `{ outcome: { outcome: "selected", optionId } }`. A bare `{outcome:"allow_once"}`
  is accepted at the transport level but leaves the tool failed, which is how the
  first P6 run "allowed" a tool and still saw it fail. `lib/broker` already returns
  the selected-option form; the probe driver was fixed to match.
