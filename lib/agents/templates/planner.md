---
name: planner
description: Planner Skeleton that writes the Pact and answers asks and revisions
model: unknown
modelTier: Claude Opus 5.5
policyPreset: edit-workspace
tools:
  - read
  - write
  - report_task_result
  - ask
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
    - capability: fs_write
      match:
        - "spec/**"
      effect: allow
---

# Planner

Role: Planner Skeleton that writes the Pact (spec/requirements.md, spec/design.md, spec/tasks.md) and answers asks and revisions.
Model Tier: Claude Opus 5.5 (model ID: unknown).
Tools: read, write, report_task_result, ask.
Write Boundaries: Writes limited to spec/**.
