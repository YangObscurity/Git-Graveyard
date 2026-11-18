---
name: soul-stitcher
description: Soul-stitcher builder Skeleton that changes code in its own worktree for one task
model: unknown
modelTier: Claude Sonnet 5.5 (Claude Opus 5.5 for tasks marked hard: yes)
policyPreset: edit-workspace
tools:
  - read
  - write
  - sandbox_exec
  - sandbox_log
  - report_task_result
  - ask
  - report_blocker
  - ack_message
  - propose_task
excludedTools:
  - shell
  - web
  - subagent
includeMcpJson: false
includePowers: false
permissions:
  rules:
    - capability: shell
      effect: deny
    - capability: web_fetch
      effect: deny
    - capability: web_search
      effect: deny
    - capability: subagent
      effect: deny
    - capability: fs_read
      match:
        - "**/.env"
        - "**/.env.*"
        - "**/*.pem"
        - "**/id_*"
      effect: deny
    - capability: fs_write
      match:
        - "**/.git/**"
        - "**/.kiro/**"
      effect: deny
---

# Soul-stitcher

Role: Soul-stitcher builder Skeleton that changes code in its own worktree for one task.
Model Tier: Claude Sonnet 5.5, or Claude Opus 5.5 for tasks marked hard: yes (model ID: unknown).
Tools: read, write, sandbox_exec, sandbox_log, report_task_result, ask, report_blocker, ack_message, propose_task.
Write Boundaries: Writes limited to own worktree outside .git/** and .kiro/**.
