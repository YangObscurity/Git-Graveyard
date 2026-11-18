---
name: scribe
description: Scribe Skeleton that writes the run report with strict evidence citations
model: unknown
modelTier: Claude Haiku 5.5
policyPreset: edit-workspace
tools:
  - read
  - write
  - report_task_result
  - ack_message
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
        - "report/**"
      effect: allow
---

# Scribe

Role: Scribe Skeleton that writes the run report with strict evidence citations.
Model Tier: Claude Haiku 5.5 (model ID: unknown).
Tools: read, write, report_task_result, ack_message.
Write Boundaries: Writes limited to report/**.
