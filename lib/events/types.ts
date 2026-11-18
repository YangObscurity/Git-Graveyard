// Task 6.1
export type EvidenceRef = string;

// Task 6.1
export interface EventData {
  refs: EvidenceRef[];
  [key: string]: unknown; // type not fixed by spec
}

// Task 6.1
export type EventKind = string;
// Event kinds found in spec (design.md R4-9, requirements.md 32/33/41/48):
// run.queued, run.queue_position, run.started, run.phase, run.clock, run.done,
// command.started, command.result, command.refused,
// grimoire.signal, grimoire.summary, exhume.certificate,
// pact.drafted, pact.revision, pact.edited, pact.approved,
// skeleton.raised, skeleton.state, skeleton.tool_call, skeleton.tool_result, skeleton.log, skeleton.usage,
// permission.decision, permission.anomaly,
// message.sent, message.delivered, message.acked, ask.raised, ask.answered, approval.requested, approval.resolved,
// necromancer.decision, task.state, gate.result, verdict,
// budget.update, budget.warning, budget.exceeded, artifact.ready, report.checked, push.requested, push.result,
// system.worker_restart, system.github_rate_limit, system.worker_state, admin.kill, admin.redaction, admin.publish

// Task 6.1
export interface EventEnvelope {
  runId: string;
  seq: number;
  ts: number;
  kind: EventKind;
  actor: string;
  data: EventData;
  skeletonId?: string;
  taskId?: string;
  attempt?: number;
}

// Requirements Glossary (Run) / Requirement 27.1
export type RunPhase =
  | "queued"
  | "exhume"
  | "plan"
  | "pact_review"
  | "legion"
  | "final_check"
  | "report"
  | "done";

// Requirements Glossary (Task) / Task 6.1
export type TaskState =
  | "pending"
  | "ready"
  | "running"
  | "in_review"
  | "rejected"
  | "merged"
  | "failed"
  | "abandoned"
  | "skipped"
  | "blocked";
