---
name: warden
description: Warden read-only reviewer Skeleton that reviews Candidate changes in isolated auditbox
model: unknown
modelTier: Claude Opus 5.5
policyPreset: read-workspace
tools:
  - read
  - sandbox_exec
  - sandbox_log
  - warden_verdict
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
      effect: deny
---

# Warden

Role: Warden read-only reviewer Skeleton that reviews Candidate changes in isolated auditbox.
Model Tier: Claude Opus 5.5 (model ID: unknown).
Tools: read, sandbox_exec, sandbox_log, warden_verdict.
Write Boundaries: No write tool provided. Zero writes permitted.
