"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { fetchRunEvents, fetchRunSummary } from "@/lib/ui/api";
import { certificateFromRun } from "@/lib/ui/certificate";
import { recallInviteCode, rememberInviteCode } from "@/lib/ui/invite-session";
import { buildRunView } from "@/lib/ui/run-model";
import { announceRunPhase } from "@/lib/ui/run-phase-bus";
import { routes } from "@/lib/ui/run-routes";
import { useRouter } from "next/navigation";
import type { PactTask, RuleId, PactRole } from "@/lib/pact/pact-parser";
import type { PactBudget, BudgetCeiling } from "@/lib/pact/pact-review";
import type {
  DeathCertificate,
  FailureClassification,
} from "@/lib/exhume/death-certificate";
import { PactBudgetSettings } from "./PactBudgetSettings";
import { PactChannel, type PactChannelMessage } from "./PactChannel";
import { PactDiff } from "./PactDiff";
import { CryptOrnament } from "./ui/CryptOrnament";
import { StatusPill } from "./ui/StatusPill";

// ---------------------------------------------------------------------------
// Pure Constants & Utilities (Client-Safe, No Node.js Dependencies)
// ---------------------------------------------------------------------------

export const NON_REMOVABLE_REQUIREMENTS = [
  "warden_final_check",
  "scribe_report",
  "grimoire_gate",
] as const;

export type NonRemovableRequirement =
  (typeof NON_REMOVABLE_REQUIREMENTS)[number];

export const NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS: Record<
  NonRemovableRequirement,
  string
> = {
  warden_final_check:
    "The Warden final check is a required verification phase before any run can complete.",
  scribe_report:
    "The Scribe report is a required evidence reporting phase that documents all resurrected changes.",
  grimoire_gate:
    "The Grimoire syntax gate is a required safety check enforcing code integrity rules M1-M6.",
};

function matchNonRemovableRequirement(
  text: string
): NonRemovableRequirement | null {
  const lower = text.toLowerCase();
  if (
    lower.includes("warden") ||
    lower.includes("final_check") ||
    lower.includes("final check")
  ) {
    return "warden_final_check";
  }
  if (lower.includes("scribe") || lower.includes("report")) {
    return "scribe_report";
  }
  if (
    lower.includes("grimoire") ||
    lower.includes("gate") ||
    lower.includes("syntax")
  ) {
    return "grimoire_gate";
  }
  return null;
}

export function isNonRemovableTask(
  task: Partial<PactTask>
): NonRemovableRequirement | null {
  if (task.title) {
    const matched = matchNonRemovableRequirement(task.title);
    if (matched) return matched;
  }
  if (task.id) {
    const matched = matchNonRemovableRequirement(task.id);
    if (matched) return matched;
  }
  return null;
}

export function detectDependencyCyclesInTasks(
  tasks: Array<{ id: string; dependencies: string[] }>
): string[][] {
  const taskMap = new Map<string, string[]>();
  for (const t of tasks) {
    taskMap.set(t.id, t.dependencies || []);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  const cycles: string[][] = [];

  function dfs(curr: string) {
    if (visiting.has(curr)) {
      const idx = path.indexOf(curr);
      if (idx !== -1) {
        cycles.push([...path.slice(idx), curr]);
      }
      return;
    }
    if (visited.has(curr)) {
      return;
    }

    visiting.add(curr);
    path.push(curr);

    const deps = taskMap.get(curr) || [];
    for (const dep of deps) {
      dfs(dep);
    }

    path.pop();
    visiting.delete(curr);
    visited.add(curr);
  }

  for (const id of taskMap.keys()) {
    if (!visited.has(id)) {
      dfs(id);
    }
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// PactEditor Component
// ---------------------------------------------------------------------------

export interface PactEditorProps {
  runId: string;
  initialData?: {
    pactVersion?: number;
    tasks?: PactTask[];
    markdown?: string;
    phase?: string;
    status?: string;
    ceiling?: BudgetCeiling;
    deathCertificate?: DeathCertificate;
  };
  inviteCode?: string;
  onApprove?: (approvalResult: unknown) => void;
  onNavigateToLegion?: (runId: string) => void;
}

export function PactEditor({
  runId,
  initialData,
  inviteCode: inviteCodeProp = "",
  onApprove,
  onNavigateToLegion,
}: PactEditorProps) {
  // The invite code comes from the prop when given, otherwise from this tab's
  // session (stored when the run was started) or from the unlock form below.
  const [sessionCode, setSessionCode] = useState<string>("");
  const [codeReady, setCodeReady] = useState<boolean>(Boolean(inviteCodeProp));
  const [authRequired, setAuthRequired] = useState<boolean>(false);
  const [codeDraft, setCodeDraft] = useState<string>("");
  const inviteCode = inviteCodeProp || sessionCode;

  useEffect(() => {
    if (inviteCodeProp) {
      rememberInviteCode(runId, inviteCodeProp);
    } else {
      setSessionCode(recallInviteCode(runId));
    }
    setCodeReady(true);
  }, [runId, inviteCodeProp]);

  let router: ReturnType<typeof useRouter> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    router = useRouter();
  } catch {
    router = null;
  }

  // Core state
  const [loading, setLoading] = useState<boolean>(!initialData);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [cycleError, setCycleError] = useState<string | null>(null);

  const [phase, setPhase] = useState<string>(initialData?.phase ?? "pact_review");
  const [status, setStatus] = useState<string>(initialData?.status ?? "ready");
  const [pactVersion, setPactVersion] = useState<number>(
    initialData?.pactVersion ?? 1
  );
  const [previousVersion, setPreviousVersion] = useState<number | undefined>(
    undefined
  );
  const [tasks, setTasks] = useState<PactTask[]>(initialData?.tasks ?? []);
  const [disabledTaskIds, setDisabledTaskIds] = useState<string[]>([]);
  const [markdown, setMarkdown] = useState<string>(initialData?.markdown ?? "");
  const [showMarkdownEditor, setShowMarkdownEditor] = useState<boolean>(false);

  // Ceilings & Budget
  const [ceiling, setCeiling] = useState<BudgetCeiling>(
    initialData?.ceiling ?? { maxMinutes: 60, maxParallel: 2, maxCredits: null }
  );
  const [budget, setBudget] = useState<PactBudget>({
    maxMinutes: initialData?.ceiling?.maxMinutes ?? 60,
    maxParallel: initialData?.ceiling?.maxParallel ?? 2,
    ...(initialData?.ceiling?.maxCredits !== null &&
    initialData?.ceiling?.maxCredits !== undefined
      ? { maxCredits: initialData.ceiling.maxCredits }
      : {}),
  });

  // Channel & Revisions
  const [channelMessages, setChannelMessages] = useState<PactChannelMessage[]>(
    []
  );
  const [isRevising, setIsRevising] = useState<boolean>(false);
  const [revisionFeedback, setRevisionFeedback] = useState<string>("");
  const [diffInfo, setDiffInfo] = useState<{
    added: string[];
    removed: string[];
    modified: string[];
    text?: string;
  } | null>(null);

  // Failures & Coverage
  const [deathCertificate, setDeathCertificate] =
    useState<DeathCertificate | null>(initialData?.deathCertificate ?? null);
  const [isStopping, setIsStopping] = useState<boolean>(false);
  const [isApproving, setIsApproving] = useState<boolean>(false);
  const [isApproved, setIsApproved] = useState<boolean>(
    initialData?.status === "approved"
  );
  const [isSavingEdit, setIsSavingEdit] = useState<boolean>(false);

  // Task inline editing state
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState<boolean>(false);
  const [newTaskForm, setNewTaskForm] = useState<{
    id: string;
    title: string;
    role: PactRole;
    dependencies: string;
    files: string;
    acceptanceCommand: string;
    hard: boolean;
    ruleIds: string;
  }>({
    id: "",
    title: "",
    role: "bonesetter",
    dependencies: "",
    files: "",
    acceptanceCommand: "npm test",
    hard: false,
    ruleIds: "M1",
  });

  // Fetch Pact and Run state from existing routes
  const fetchPactData = useCallback(async () => {
    try {
      setLoading(true);
      setErrorMessage(null);

      const pactRes = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/pact`,
        {
          headers: inviteCode ? { "x-invite-code": inviteCode } : {},
        }
      );

      if (!pactRes.ok) {
        const errJson = await pactRes.json().catch(() => ({}));
        if (pactRes.status === 401 || pactRes.status === 403) {
          setAuthRequired(true);
          setErrorMessage(
            inviteCode
              ? "This invite code does not open the Pact of this run. Enter the code the run was started with."
              : "This Pact is only shown to the holder of the invite code the run was started with. Enter that code."
          );
        } else if (pactRes.status === 404) {
          setErrorMessage(
            `No run with the ID ${runId} is recorded here. Check the link, or pick a run from History.`
          );
        } else {
          setErrorMessage(
            errJson.error || `Unable to load Pact. Status code: ${pactRes.status}.`
          );
        }
        setLoading(false);
        return;
      }
      setAuthRequired(false);

      const pactData = await pactRes.json();
      if (pactData.phase) setPhase(pactData.phase);
      // GET /api/runs/[runId]/pact omits `status` once a Pact has been drafted;
      // derive it from tasks/approval so refreshing from drafting opens the editor.
      if (pactData.status) {
        setStatus(pactData.status);
      } else if (Array.isArray(pactData.tasks) && pactData.tasks.length > 0) {
        setStatus(pactData.isApproved ? "approved" : "ready");
      }
      if (typeof pactData.pactVersion === "number") {
        setPactVersion(pactData.pactVersion);
      }
      if (Array.isArray(pactData.tasks)) {
        setTasks(pactData.tasks);
      }
      if (typeof pactData.markdown === "string") {
        setMarkdown(pactData.markdown);
      }
      if (pactData.pendingRevision) {
        setIsRevising(true);
      } else {
        setIsRevising(false);
      }
      if (pactData.isApproved === true) {
        setIsApproved(true);
      }

      // Channel and Death Certificate come from the event log of the run; the
      // budget ceilings are the caps stored on the run. Both are supplementary:
      // the Pact stays usable if either read fails.
      const [eventsResult, summaryResult] = await Promise.all([
        fetchRunEvents(runId, 1),
        fetchRunSummary(runId),
      ]);
      if (eventsResult.ok) {
        const runView = buildRunView(eventsResult.events);
        setChannelMessages(
          runView.channel.map((entry) => ({
            id: entry.id,
            kind: entry.type,
            actor: entry.actor || "necromancer",
            text: entry.text,
            ts: entry.ts || undefined,
            refs: entry.refs,
          }))
        );
        const cert = certificateFromRun(runView, runId);
        if (cert) {
          setDeathCertificate((prev) => prev ?? cert);
        }
      }
      if (summaryResult.ok) {
        const caps = summaryResult.summary.caps;
        if (
          caps &&
          typeof caps.maxMinutes === "number" &&
          typeof caps.maxParallel === "number"
        ) {
          const nextCeiling = caps as unknown as BudgetCeiling;
          setCeiling(nextCeiling);
          setBudget((prev) => ({
            maxMinutes: Math.min(
              prev.maxMinutes,
              nextCeiling.maxMinutes ?? prev.maxMinutes
            ),
            maxParallel: Math.min(
              prev.maxParallel,
              nextCeiling.maxParallel ?? prev.maxParallel
            ),
            ...(typeof nextCeiling.maxCredits === "number"
              ? {
                  maxCredits:
                    typeof prev.maxCredits === "number"
                      ? Math.min(prev.maxCredits, nextCeiling.maxCredits)
                      : nextCeiling.maxCredits,
                }
              : prev.maxCredits !== undefined
                ? { maxCredits: prev.maxCredits }
                : {}),
            ...(typeof nextCeiling.maxToolCalls === "number"
              ? {
                  maxToolCalls:
                    typeof prev.maxToolCalls === "number"
                      ? Math.min(prev.maxToolCalls, nextCeiling.maxToolCalls)
                      : nextCeiling.maxToolCalls,
                }
              : prev.maxToolCalls !== undefined
                ? { maxToolCalls: prev.maxToolCalls }
                : {}),
          }));
        }
        if (!pactData.phase && summaryResult.summary.phase) {
          setPhase(summaryResult.summary.phase);
        }
      }

      setLoading(false);
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to connect to the server."
      );
      setLoading(false);
    }
  }, [runId, inviteCode]);

  useEffect(() => {
    if (!initialData && codeReady) {
      fetchPactData();
    }
  }, [initialData, codeReady, fetchPactData]);

  // Let the nav stepper follow the run.
  useEffect(() => {
    if (!initialData && !loading && !errorMessage && phase) {
      announceRunPhase({ runId, phase });
    }
  }, [initialData, loading, errorMessage, runId, phase]);

  const handleUnlock = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = codeDraft.trim();
    if (!clean) return;
    rememberInviteCode(runId, clean);
    setCodeDraft("");
    setSessionCode(clean);
  };

  // Navigate to Legion Dashboard on approval (Requirement 36.7)
  const navigateToLegion = useCallback(() => {
    if (onNavigateToLegion) {
      onNavigateToLegion(runId);
      return;
    }
    const target = `/runs/${encodeURIComponent(runId)}/legion`;
    if (router) {
      router.push(target);
    } else if (typeof window !== "undefined") {
      window.location.href = target;
    }
  }, [onNavigateToLegion, runId, router]);

  // Check non-removable requirements (Requirement 36.8)
  const isTaskLocked = useCallback((task: PactTask): {
    locked: boolean;
    reason?: string;
  } => {
    const matched = isNonRemovableTask(task);
    if (matched) {
      return {
        locked: true,
        reason: NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS[matched],
      };
    }
    return { locked: false };
  }, []);

  // Ensure non-removable requirements are always present or represented
  const nonRemovableCheck = useMemo(() => {
    const items: Array<{
      key: NonRemovableRequirement;
      name: string;
      reason: string;
      presentInTasks: boolean;
    }> = [
      {
        key: "warden_final_check",
        name: "Warden Final Check",
        reason: NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS.warden_final_check,
        presentInTasks: tasks.some((t) => isNonRemovableTask(t) === "warden_final_check"),
      },
      {
        key: "scribe_report",
        name: "Scribe Report",
        reason: NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS.scribe_report,
        presentInTasks: tasks.some((t) => isNonRemovableTask(t) === "scribe_report"),
      },
      {
        key: "grimoire_gate",
        name: "Grimoire Syntax Gate",
        reason: NON_REMOVABLE_REQUIREMENT_DESCRIPTIONS.grimoire_gate,
        presentInTasks: tasks.some((t) => isNonRemovableTask(t) === "grimoire_gate"),
      },
    ];
    return items;
  }, [tasks]);

  // Requirement 36.10: Flag every task that depends on a disabled task
  const flaggedDependencies = useMemo(() => {
    const flagged: Array<{ taskId: string; dependsOnDisabled: string }> = [];
    if (disabledTaskIds.length === 0) return flagged;

    for (const task of tasks) {
      if (disabledTaskIds.includes(task.id)) continue;
      const deps = task.dependencies || task.depends || task.dependsOn || [];
      for (const dep of deps) {
        if (disabledTaskIds.includes(dep)) {
          flagged.push({ taskId: task.id, dependsOnDisabled: dep });
        }
      }
    }
    return flagged;
  }, [tasks, disabledTaskIds]);

  // Requirement 36.4: Coverage check for uncovered failures under "Not addressed by any task"
  const uncoveredFailures = useMemo(() => {
    const certFailures = deathCertificate?.failures || [];
    if (certFailures.length === 0) {
      return [];
    }

    const uncovered: FailureClassification[] = [];
    for (const f of certFailures) {
      let covered = false;
      for (const task of tasks) {
        if (disabledTaskIds.includes(task.id)) continue;

        if (
          f.ruleId &&
          (task.ruleIds?.includes(f.ruleId as RuleId) ||
            task.rules?.includes(f.ruleId as RuleId))
        ) {
          covered = true;
          break;
        }

        if (f.step && task.title.toLowerCase().includes(f.step.toLowerCase())) {
          covered = true;
          break;
        }

        if (f.class && task.title.toLowerCase().includes(f.class.toLowerCase())) {
          covered = true;
          break;
        }
      }

      if (!covered) {
        uncovered.push(f);
      }
    }
    return uncovered;
  }, [deathCertificate, tasks, disabledTaskIds]);

  const liveCycles = useMemo(() => {
    const active = tasks.filter((t) => !disabledTaskIds.includes(t.id));
    return detectDependencyCyclesInTasks(
      active.map((t) => ({
        id: t.id,
        dependencies: t.dependencies || t.depends || [],
      }))
    );
  }, [tasks, disabledTaskIds]);

  // Toggle task enabled/disabled (Requirement 36.10)
  const handleToggleTask = (taskId: string) => {
    const targetTask = tasks.find((t) => t.id === taskId);
    if (targetTask && isTaskLocked(targetTask).locked) {
      return;
    }

    setDisabledTaskIds((prev) => {
      if (prev.includes(taskId)) {
        return prev.filter((id) => id !== taskId);
      } else {
        return [...prev, taskId];
      }
    });
  };

  // Delete a task (only if not locked)
  const handleDeleteTask = (taskId: string) => {
    const targetTask = tasks.find((t) => t.id === taskId);
    if (targetTask && isTaskLocked(targetTask).locked) {
      return;
    }
    const updated = tasks.filter((t) => t.id !== taskId);
    setTasks(updated);
    setDisabledTaskIds((prev) => prev.filter((id) => id !== taskId));
  };

  // Save Task Edits (Requirement 36.9: dependency cycle check; Requirement 36.14: submit to API)
  const handleSaveEdits = async (candidateTasks: PactTask[]) => {
    setValidationError(null);
    setCycleError(null);

    // Requirement 36.9: detect dependency cycles and reject naming the cycle
    const cycleTasks = candidateTasks.map((t) => ({
      id: t.id,
      dependencies: t.dependencies || t.depends || [],
    }));
    const cycles = detectDependencyCyclesInTasks(cycleTasks);
    if (cycles.length > 0) {
      const cycleStr = cycles[0].join(" -> ");
      setCycleError(`Dependency cycle detected: ${cycleStr}`);
      return;
    }

    try {
      setIsSavingEdit(true);
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/pact`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(inviteCode ? { "x-invite-code": inviteCode } : {}),
        },
        body: JSON.stringify({
          action: "edit",
          inviteCode: inviteCode || undefined,
          tasks: candidateTasks,
          disabledTaskIds,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setAuthRequired(res.status === 401 || res.status === 403);
        setValidationError(
          data.error || "Failed to save edits to the Pact."
        );
        setIsSavingEdit(false);
        return;
      }

      setPreviousVersion(pactVersion);
      if (typeof data.pactVersion === "number") {
        setPactVersion(data.pactVersion);
      }
      if (Array.isArray(data.tasks)) {
        setTasks(data.tasks);
      }
      if (typeof data.markdown === "string") {
        setMarkdown(data.markdown);
      }
      if (data.diff) {
        setDiffInfo(data.diff);
      }

      setIsSavingEdit(false);
      setEditingTaskId(null);
    } catch (err: unknown) {
      setValidationError(
        err instanceof Error ? err.message : "Error saving edits."
      );
      setIsSavingEdit(false);
    }
  };

  // Handle Raw Markdown Edit Save
  const handleSaveMarkdownEdit = async () => {
    setValidationError(null);
    setCycleError(null);
    try {
      setIsSavingEdit(true);
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/pact`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(inviteCode ? { "x-invite-code": inviteCode } : {}),
        },
        body: JSON.stringify({
          action: "edit",
          inviteCode: inviteCode || undefined,
          markdown,
          disabledTaskIds,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setAuthRequired(res.status === 401 || res.status === 403);
        setValidationError(
          data.error || "Pact markdown parsing or validation failed."
        );
        setIsSavingEdit(false);
        return;
      }

      setPreviousVersion(pactVersion);
      if (typeof data.pactVersion === "number") {
        setPactVersion(data.pactVersion);
      }
      if (Array.isArray(data.tasks)) {
        setTasks(data.tasks);
      }
      if (typeof data.markdown === "string") {
        setMarkdown(data.markdown);
      }
      if (data.diff) {
        setDiffInfo(data.diff);
      }
      setShowMarkdownEditor(false);
      setIsSavingEdit(false);
    } catch (err: unknown) {
      setValidationError(
        err instanceof Error ? err.message : "Error saving markdown."
      );
      setIsSavingEdit(false);
    }
  };

  // Approve Pact (Requirement 36.7: open Legion_Dashboard on approval)
  const handleApprove = async () => {
    setValidationError(null);
    setCycleError(null);
    const activeTasks = tasks.filter((t) => !disabledTaskIds.includes(t.id));
    const approvedTaskIds = activeTasks.map((t) => t.id);

    if (approvedTaskIds.length === 0) {
      setValidationError("Cannot approve an empty Pact. Please enable at least one task.");
      return;
    }

    // Requirement 36.9: reject approval when the active tasks contain a
    // dependency cycle, naming the exact cycle path.
    const approvalCycles = detectDependencyCyclesInTasks(
      activeTasks.map((t) => ({
        id: t.id,
        dependencies: t.dependencies || t.depends || [],
      }))
    );
    if (approvalCycles.length > 0) {
      setCycleError(
        `Dependency cycle detected: ${approvalCycles[0].join(" -> ")}`
      );
      return;
    }

    try {
      setIsApproving(true);
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/pact`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(inviteCode ? { "x-invite-code": inviteCode } : {}),
        },
        body: JSON.stringify({
          action: "approve",
          inviteCode: inviteCode || undefined,
          pactVersion,
          approvedTaskIds,
          budget,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setAuthRequired(res.status === 401 || res.status === 403);
        const detail =
          Array.isArray(data.errors) && data.errors.length > 0
            ? `: ${data.errors.map(String).join("; ")}`
            : "";
        setValidationError((data.error || "Approval rejected by server.") + detail);
        setIsApproving(false);
        return;
      }

      setIsApproving(false);
      setIsApproved(true);
      if (onApprove) {
        onApprove(data);
      }
      navigateToLegion();
    } catch (err: unknown) {
      setValidationError(
        err instanceof Error ? err.message : "Approval request failed."
      );
      setIsApproving(false);
    }
  };

  // Revision Request (Requirement 13.3, 36.5)
  const handleRequestRevision = async () => {
    if (!revisionFeedback.trim()) return;
    setValidationError(null);
    try {
      setIsRevising(true);
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/pact`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(inviteCode ? { "x-invite-code": inviteCode } : {}),
        },
        body: JSON.stringify({
          action: "revise",
          inviteCode: inviteCode || undefined,
          feedback: revisionFeedback.trim(),
        }),
      });

      if (!res.ok) {
        setAuthRequired(res.status === 401 || res.status === 403);
        const data = await res.json().catch(() => ({}));
        setIsRevising(false);
        setValidationError(
          data.error ||
            `The revision request was not accepted (status ${res.status}). Your feedback is kept; try again.`
        );
        return;
      }
      setRevisionFeedback("");
    } catch {
      setIsRevising(false);
      setValidationError(
        "The revision request did not reach the server. Your feedback is kept; try again."
      );
    }
  };

  // Stop Run (Requirement 36.2, 36.3)
  const handleStopRun = async () => {
    setValidationError(null);
    try {
      setIsStopping(true);
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/pact`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(inviteCode ? { "x-invite-code": inviteCode } : {}),
        },
        body: JSON.stringify({
          action: "stop",
          inviteCode: inviteCode || undefined,
          reason: "Stopped by user on Pact screen",
        }),
      });
      setIsStopping(false);
      if (!res.ok) {
        setAuthRequired(res.status === 401 || res.status === 403);
        const data = await res.json().catch(() => ({}));
        setValidationError(
          data.error ||
            `The run was not stopped (status ${res.status}). It is still active; try again.`
        );
        return;
      }
      setPhase("done");
      setStatus("stopped");
    } catch {
      setIsStopping(false);
      setValidationError(
        "The stop request did not reach the server. The run is still active; try again."
      );
    }
  };

  // Resume Parked Run (Requirement 36.6)
  const handleResumeParkedRun = async () => {
    try {
      setLoading(true);
      await fetchPactData();
      setPhase("pact_review");
    } catch {
      setLoading(false);
    }
  };

  // Add Task to List
  const handleAddNewTask = () => {
    if (!newTaskForm.id.trim() || !newTaskForm.title.trim()) {
      setValidationError("Task ID and title are required.");
      return;
    }

    const newTask: PactTask = {
      id: newTaskForm.id.trim(),
      title: newTaskForm.title.trim(),
      role: newTaskForm.role,
      dependencies: newTaskForm.dependencies
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      depends: newTaskForm.dependencies
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      dependsOn: newTaskForm.dependencies
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      files: newTaskForm.files
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      filesInScope: newTaskForm.files
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      acceptanceCommand: newTaskForm.acceptanceCommand.trim() || "npm test",
      accept: newTaskForm.acceptanceCommand.trim() || "npm test",
      hard: newTaskForm.hard,
      hardFlag: newTaskForm.hard,
      hardRaw: newTaskForm.hard ? "yes" : "no",
      ruleIds: newTaskForm.ruleIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as RuleId[],
      rules: newTaskForm.ruleIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as RuleId[],
      line: tasks.length + 1,
    };

    const nextTasks = [...tasks, newTask];
    setTasks(nextTasks);
    setNewTaskOpen(false);
    setNewTaskForm({
      id: "",
      title: "",
      role: "bonesetter",
      dependencies: "",
      files: "",
      acceptanceCommand: "npm test",
      hard: false,
      ruleIds: "M1",
    });
    handleSaveEdits(nextTasks);
  };

  // -------------------------------------------------------------------------
  // Render States
  // -------------------------------------------------------------------------

  const activeCycleMessage =
    cycleError ??
    (liveCycles.length > 0
      ? `Dependency cycle detected: ${liveCycles[0].join(" -> ")}`
      : null);
  const editorVariant = showMarkdownEditor ? "markdown" : "cards";
  const editorUiState = activeCycleMessage
    ? "has-cycles"
    : isApproving
    ? "approving"
    : isApproved || status === "approved"
    ? "approved"
    : validationError
    ? "error"
    : "draft";

  if (loading) {
    return (
      <div
        data-testid="pact-loading"
        data-ui-element="pact-editor"
        data-ui-state="loading"
        data-ui-variant={editorVariant}
        className="crypt-panel p-8 font-mono text-xs text-ash space-y-4 text-center"
      >
        <div className="crypt-well bg-neutral-950/70 px-4 py-3 inline-flex items-center gap-2.5 text-ash mx-auto">
          <span
            aria-hidden="true"
            className="w-2 h-2 rounded-full bg-emerald-400 crypt-pulse-emerald"
          />
          <p>Checking the crypt...</p>
        </div>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div
        data-testid="pact-error-screen"
        data-ui-element="pact-editor"
        data-ui-state="error"
        data-ui-variant={editorVariant}
        className="crypt-panel border-l-2 border-l-rose-500 p-6 font-mono text-xs text-parchment space-y-4"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-rose-300 uppercase tracking-wide">
            Pact Error
          </h2>
          <StatusPill tone="crimson" label="Error" uiState="error" />
        </div>
        <p data-testid="pact-error-message" className="text-parchment">
          {errorMessage}
        </p>
        {validationError && (
          <p data-testid="pact-error-action-failed" className="text-rose-300">
            {validationError}
          </p>
        )}
        {authRequired && (
          <form
            onSubmit={handleUnlock}
            data-testid="pact-unlock-form"
            className="flex flex-col sm:flex-row gap-3"
          >
            <label htmlFor="pact-unlock-code" className="sr-only">
              Invite code
            </label>
            <div className="crypt-well flex-1">
              <input
                id="pact-unlock-code"
                data-testid="pact-unlock-code-input"
                type="text"
                autoComplete="off"
                value={codeDraft}
                onChange={(e) => setCodeDraft(e.target.value)}
                placeholder="Invite code"
                className="w-full px-3.5 py-2.5 bg-transparent text-bone placeholder-neutral-500 text-xs focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={!codeDraft.trim()}
              data-testid="pact-unlock-submit"
              className="crypt-btn-primary px-4 py-2 rounded font-semibold"
            >
              Open the Pact
            </button>
          </form>
        )}
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            data-testid="pact-btn-retry"
            onClick={fetchPactData}
            className="crypt-btn-ghost px-4 py-2 rounded font-semibold"
          >
            Try again
          </button>
          <button
            type="button"
            data-testid="pact-btn-stop"
            onClick={handleStopRun}
            className="crypt-btn-danger px-4 py-2 rounded font-semibold"
          >
            Stop
          </button>
        </div>
      </div>
    );
  }

  // Requirement 36.1: WHILE Planner is writing the Pact, show drafting sentence and channel
  const isDrafting =
    status === "drafting" || phase === "plan" || (tasks.length === 0 && !status.includes("nothing"));

  if (isDrafting) {
    return (
      <div
        data-testid="pact-drafting-screen"
        data-ui-element="pact-editor"
        data-ui-state="draft"
        data-ui-variant={editorVariant}
        className="crypt-panel-engraved p-6 font-mono text-xs space-y-6"
      >
        <div className="border-b border-white/[0.08] pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-bold text-bone uppercase tracking-wider">
                The Pact
              </h2>
              <StatusPill tone="amber" pulse label="Drafting" uiState="draft" />
            </div>
            <p
              data-testid="pact-drafting-sentence"
              className="text-amber-300 text-sm mt-1.5 font-semibold"
            >
              The Necromancer&apos;s Planner is writing the Pact
            </p>
          </div>
          <button
            type="button"
            data-testid="pact-btn-refresh"
            onClick={fetchPactData}
            className="crypt-btn-ghost px-3 py-1.5 rounded text-xs self-start sm:self-auto"
          >
            Check status
          </button>
        </div>

        {/* Visible Necromancer channel while drafting */}
        <PactChannel messages={channelMessages} isDrafting={true} />
      </div>
    );
  }

  // Requirement 36.2: Planner finds nothing to change -> show reason and Stop button
  if (status === "nothing_to_change" || (tasks.length === 0 && phase !== "pact_review")) {
    return (
      <div
        data-testid="pact-nothing-screen"
        data-ui-element="pact-editor"
        data-ui-state="draft"
        data-ui-variant={editorVariant}
        className="crypt-panel p-6 font-mono text-xs space-y-5"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-bone uppercase tracking-wide">
            The Pact: No Changes Needed
          </h2>
          <StatusPill tone="neutral" label="No Changes" uiState="draft" />
        </div>
        <div
          data-testid="pact-nothing-reason"
          className="crypt-well p-4 text-parchment leading-relaxed"
        >
          The repository code is already healthy or the Planner found nothing to change.
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            data-testid="pact-btn-stop-nothing"
            onClick={handleStopRun}
            disabled={isStopping}
            className="crypt-btn-danger px-4 py-2 rounded font-semibold"
          >
            {isStopping ? "Stopping..." : "Stop"}
          </button>
        </div>
      </div>
    );
  }

  // Requirement 36.6: While run is parked -> offer Resume and state resuming clones repository again
  const isParked = phase === "parked" || status === "parked";
  if (isParked) {
    return (
      <div
        data-testid="pact-parked-screen"
        data-ui-element="pact-editor"
        data-ui-state="draft"
        data-ui-variant={editorVariant}
        className="crypt-panel p-6 font-mono text-xs space-y-5"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-bone uppercase tracking-wide">
            Run Parked
          </h2>
          <StatusPill tone="amber" label="Parked" uiState="draft" />
        </div>
        <div
          data-testid="pact-parked-notice"
          className="crypt-well p-4 text-parchment leading-relaxed space-y-2"
        >
          <p>This run is currently parked because it was idle during Pact review.</p>
          <p className="text-amber-300 font-semibold">
            Resuming clones the repository again.
          </p>
        </div>
        <div>
          <button
            type="button"
            data-testid="pact-btn-resume"
            onClick={handleResumeParkedRun}
            className="crypt-btn-primary px-4 py-2 rounded font-semibold"
          >
            Resume
          </button>
        </div>
      </div>
    );
  }

  const activeTaskCount = tasks.filter(
    (t) => !disabledTaskIds.includes(t.id)
  ).length;
  const isReadOnlyPhase =
    phase === "legion" ||
    phase === "final_check" ||
    phase === "report" ||
    phase === "done";
  const mutationsLocked = isRevising || isReadOnlyPhase;

  // Main Pact Review & Edit Screen
  return (
    <div
      data-testid="pact-editor"
      data-ui-element="pact-editor"
      data-ui-state={editorUiState}
      data-ui-variant={editorVariant}
      className="space-y-6 font-mono text-xs"
    >
      {/* Where the run is, when it has already moved past Pact review */}
      {(phase === "legion" || phase === "final_check" || phase === "report") && (
        <div
          data-testid="pact-moved-on-notice"
          className="crypt-panel p-4 border-l-2 border-l-emerald-400 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-parchment"
        >
          <p>
            This Pact is approved and the Legion is carrying it out. It is shown
            here as approved; changes are no longer accepted.
          </p>
          <a
            href={routes.legion(runId)}
            className="crypt-btn-primary px-4 py-2 rounded font-semibold shrink-0"
          >
            Open the Legion
          </a>
        </div>
      )}
      {phase === "done" && (
        <div
          data-testid="pact-run-done-notice"
          className="crypt-panel p-4 border-l-2 border-l-neutral-500 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-parchment"
        >
          <p>This run has ended. The Pact is shown as it stood.</p>
          <a
            href={routes.relic(runId)}
            className="crypt-btn-ghost px-4 py-2 rounded font-semibold shrink-0"
          >
            Open the Reliquary
          </a>
        </div>
      )}

      {/* Top Pact Header Bar: sticky from md up; on phones it scrolls with the page
          so it does not cover the sections below it. */}
      <div className="crypt-panel-engraved p-4 md:p-5 md:sticky md:top-14 md:z-20 backdrop-blur-md space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-bold text-bone uppercase tracking-wider">
                Pact Review &amp; Approval
              </h2>
              <span
                data-testid="pact-version-badge"
                className="px-2.5 py-0.5 rounded-full text-[11px] bg-emerald-950/50 text-emerald-300 border border-emerald-500/35 font-semibold"
              >
                Version: {pactVersion}
              </span>
              <StatusPill
                tone={
                  activeCycleMessage
                    ? "crimson"
                    : isRevising
                    ? "amber"
                    : editorUiState === "approved"
                    ? "emerald"
                    : "emerald"
                }
                pulse={isRevising || isApproving}
                label={
                  activeCycleMessage
                    ? "Cycle Detected"
                    : isRevising
                    ? "Revising"
                    : isApproving
                    ? "Approving"
                    : editorUiState === "approved"
                    ? "Approved"
                    : "Pact Ready"
                }
                uiState={editorUiState}
              />
            </div>
            <p className="text-ash text-xs">
              Read, edit, and approve the resurrection plan before skeletons are raised.
            </p>
          </div>

          {/* Primary header actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="pact-btn-toggle-markdown"
              onClick={() => setShowMarkdownEditor(!showMarkdownEditor)}
              className="crypt-btn-ghost px-3 py-1.5 rounded text-xs"
            >
              {showMarkdownEditor ? "Task List View" : "Raw Markdown"}
            </button>
            <button
              type="button"
              data-testid="pact-btn-stop"
              onClick={handleStopRun}
              disabled={isStopping || isReadOnlyPhase}
              className="crypt-btn-danger px-3 py-1.5 rounded text-xs"
            >
              Stop
            </button>
            <button
              type="button"
              data-testid="pact-btn-approve"
              onClick={handleApprove}
              disabled={isApproving || isRevising || isSavingEdit || isReadOnlyPhase}
              className="crypt-btn-primary px-4 py-1.5 rounded text-xs uppercase tracking-wider"
            >
              <CryptOrnament kind="wax-seal" className="w-4 h-4" />
              <span>
                {isApproving
                  ? "Approving..."
                  : isReadOnlyPhase
                  ? isApproved
                    ? "Approved"
                    : "Locked"
                  : "Seal & Approve Pact"}
              </span>
            </button>
          </div>
        </div>

        {/* Non-removable requirement lock badges */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-white/[0.06] text-[11px]">
          <span className="text-dust uppercase tracking-wider text-[10px]">
            Mandatory Wards:
          </span>
          <span className="px-2 py-0.5 rounded bg-amber-950/40 border border-amber-500/35 text-amber-200">
            Grimoire Gate
          </span>
          <span className="px-2 py-0.5 rounded bg-amber-950/40 border border-amber-500/35 text-amber-200">
            Warden Audit
          </span>
          <span className="px-2 py-0.5 rounded bg-amber-950/40 border border-amber-500/35 text-amber-200">
            Scribe Report
          </span>
          <span className="ml-auto text-ash tabular-nums">
            {activeTaskCount} / {tasks.length} tasks active
          </span>
        </div>
      </div>

      {/* Cycle Error (Requirement 36.9) */}
      {activeCycleMessage && (
        <div
          data-testid="pact-cycle-error"
          className="crypt-panel border-l-2 border-l-rose-500 bg-rose-950/30 border-rose-500/40 p-4 text-rose-200 flex items-start gap-3"
        >
          <CryptOrnament kind="wax-seal" className="w-5 h-5 text-rose-400 mt-0.5" />
          <div className="space-y-1">
            <h4 className="font-bold uppercase tracking-wide text-xs text-rose-300">
              Cycle Error
            </h4>
            <p>{activeCycleMessage}</p>
          </div>
        </div>
      )}

      {/* A change was refused for lack of the invite code: ask for it here */}
      {authRequired && (
        <form
          onSubmit={(e) => {
            handleUnlock(e);
            setAuthRequired(false);
            setValidationError(null);
          }}
          data-testid="pact-unlock-form"
          className="crypt-panel border-l-2 border-l-amber-400 p-4 space-y-3"
        >
          <p className="text-parchment">
            Changing or approving this Pact needs the invite code the run was
            started with. Enter it, then repeat the action.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <label htmlFor="pact-unlock-code-inline" className="sr-only">
              Invite code
            </label>
            <div className="crypt-well flex-1">
              <input
                id="pact-unlock-code-inline"
                data-testid="pact-unlock-code-input"
                type="text"
                autoComplete="off"
                value={codeDraft}
                onChange={(e) => setCodeDraft(e.target.value)}
                placeholder="Invite code"
                className="w-full px-3.5 py-2.5 bg-transparent text-bone placeholder-neutral-500 text-xs focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={!codeDraft.trim()}
              data-testid="pact-unlock-submit"
              className="crypt-btn-primary px-4 py-2 rounded font-semibold"
            >
              Use this code
            </button>
          </div>
        </form>
      )}

      {/* Validation Error (Requirement 36.3) */}
      {validationError && (
        <div
          data-testid="pact-validation-error"
          className="crypt-panel border-l-2 border-l-amber-400 bg-amber-950/25 border-amber-500/40 p-4 text-amber-200 space-y-2"
        >
          <h4 className="font-bold uppercase tracking-wide text-xs text-amber-300">
            Validation Error
          </h4>
          <p>{validationError}</p>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              data-testid="pact-btn-try-again"
              onClick={() => setValidationError(null)}
              className="crypt-btn-ghost px-3 py-1 rounded text-[11px]"
            >
              Try again
            </button>
            <button
              type="button"
              data-testid="pact-btn-stop-from-error"
              onClick={handleStopRun}
              className="crypt-btn-danger px-3 py-1 rounded text-[11px]"
            >
              Stop
            </button>
          </div>
        </div>
      )}

      {/* Flagged Tasks Warning (Requirement 36.10) */}
      {flaggedDependencies.length > 0 && (
        <div
          data-testid="pact-flagged-dependencies"
          className="crypt-panel border-l-2 border-l-amber-400/80 bg-amber-950/20 border-amber-500/35 p-4 text-amber-200 space-y-2"
        >
          <h4 className="font-bold uppercase tracking-wide text-xs text-amber-300">
            Flagged Tasks (Disabled Dependency)
          </h4>
          <ul className="list-disc list-inside space-y-1 text-xs">
            {flaggedDependencies.map((f, i) => (
              <li key={i}>
                Task <span className="font-bold text-bone">{f.taskId}</span> depends on disabled task{" "}
                <span className="font-bold text-bone">{f.dependsOnDisabled}</span>.
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Requirement 36.5: Revision Diff */}
      {diffInfo && (
        <PactDiff
          previousVersion={previousVersion}
          currentVersion={pactVersion}
          addedTaskIds={diffInfo.added}
          removedTaskIds={diffInfo.removed}
          modifiedTaskIds={diffInfo.modified}
          diffText={diffInfo.text}
        />
      )}

      {/* Requirement 36.5: Planner is revising Pact -> Lock edits */}
      {isRevising && (
        <div
          data-testid="pact-revising-banner"
          className="crypt-panel border-l-2 border-l-amber-400 bg-amber-950/25 border-amber-500/35 p-4 text-amber-200 flex items-center justify-between gap-3"
        >
          <span>The Planner is revising the Pact. Edits are currently locked.</span>
          <button
            type="button"
            onClick={fetchPactData}
            className="crypt-btn-ghost px-2.5 py-1 rounded text-xs"
          >
            Check for update
          </button>
        </div>
      )}

      {/* Markdown View or Structured Tasks View */}
      {showMarkdownEditor ? (
        <div
          data-testid="pact-raw-markdown-editor"
          className="crypt-panel p-5 space-y-3"
        >
          <label htmlFor="pact-markdown-text" className="font-semibold text-parchment block">
            Raw tasks.md Markdown:
          </label>
          <textarea
            id="pact-markdown-text"
            data-testid="pact-markdown-textarea"
            rows={14}
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            disabled={mutationsLocked || isSavingEdit}
            className="crypt-well w-full p-3 font-mono text-xs text-bone focus:outline-none focus:border-emerald-400/60 disabled:opacity-50"
          />
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="pact-btn-save-markdown"
              onClick={handleSaveMarkdownEdit}
              disabled={mutationsLocked || isSavingEdit}
              className="crypt-btn-primary px-4 py-2 rounded font-semibold text-xs"
            >
              {isSavingEdit ? "Saving..." : "Save Markdown"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Locked Requirements Banner / List (Requirement 36.8) */}
          <div
            data-testid="pact-locked-requirements-panel"
            className="crypt-panel p-5 space-y-3"
          >
            <div className="border-b border-white/[0.08] pb-2.5">
              <h3 className="text-xs font-semibold text-bone uppercase tracking-wide">
                Non-Removable Verification Requirements
              </h3>
              <p className="text-ash text-[11px] mt-0.5">
                These phases are mandatory safeguards enforced by the resurrection engine.
              </p>
            </div>

            <div className="space-y-2">
              {nonRemovableCheck.map((item) => (
                <div
                  key={item.key}
                  data-testid={`locked-req-${item.key}`}
                  className="crypt-well border-l-2 border-l-amber-400/70 flex items-start justify-between gap-3 p-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={true}
                        disabled={true}
                        readOnly
                        aria-disabled="true"
                        aria-label={`${item.name} (required check, cannot be removed)`}
                        className="rounded border-white/20 bg-recessed text-amber-400 cursor-not-allowed"
                      />
                      <span className="font-bold text-bone text-xs">
                        {item.name}
                      </span>
                      <span
                        title={item.reason}
                        className="px-1.5 py-0.5 rounded text-[10px] bg-amber-950/50 border border-amber-500/35 text-amber-300 font-semibold"
                      >
                        [Locked]
                      </span>
                    </div>
                    <p
                      data-testid={`locked-reason-${item.key}`}
                      className="text-ash text-[11px] pl-5 leading-relaxed"
                    >
                      {item.reason}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Task List (Requirement 15.3, 36.8, 36.14) */}
          <div className="space-y-4" data-testid="pact-task-list">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-2.5">
              <div>
                <h3 className="text-sm font-semibold text-bone uppercase tracking-wide">
                  Planned Tasks
                </h3>
                <p className="text-ash text-[11px]">
                  Tasks to be executed by Bonesetter and Soul-stitcher skeletons.
                </p>
              </div>
              <button
                type="button"
                data-testid="pact-btn-add-task-open"
                onClick={() => setNewTaskOpen(!newTaskOpen)}
                disabled={mutationsLocked}
                className="crypt-btn-ghost px-3 py-1.5 rounded text-xs font-semibold"
              >
                {newTaskOpen ? "Cancel" : "+ Add Task"}
              </button>
            </div>

            {/* New Task Form */}
            {newTaskOpen && (
              <div
                data-testid="pact-new-task-form"
                className="crypt-panel p-4 border-emerald-500/30 space-y-3"
              >
                <h4 className="font-bold text-bone text-xs uppercase tracking-wide">
                  Add New Task
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="text-ash block mb-1">Task ID (e.g. T4)</label>
                    <input
                      type="text"
                      data-testid="new-task-id"
                      value={newTaskForm.id}
                      onChange={(e) =>
                        setNewTaskForm({ ...newTaskForm, id: e.target.value })
                      }
                      className="crypt-well w-full px-2.5 py-1.5 text-bone focus:outline-none focus:border-emerald-400/60"
                    />
                  </div>
                  <div>
                    <label className="text-ash block mb-1">Title</label>
                    <input
                      type="text"
                      data-testid="new-task-title"
                      value={newTaskForm.title}
                      onChange={(e) =>
                        setNewTaskForm({ ...newTaskForm, title: e.target.value })
                      }
                      className="crypt-well w-full px-2.5 py-1.5 text-bone focus:outline-none focus:border-emerald-400/60"
                    />
                  </div>
                  <div>
                    <label className="text-ash block mb-1">Role</label>
                    <select
                      data-testid="new-task-role"
                      value={newTaskForm.role}
                      onChange={(e) =>
                        setNewTaskForm({
                          ...newTaskForm,
                          role: e.target.value as PactRole,
                        })
                      }
                      className="crypt-well w-full px-2.5 py-1.5 text-bone focus:outline-none focus:border-emerald-400/60"
                    >
                      <option value="bonesetter">bonesetter</option>
                      <option value="soul-stitcher">soul-stitcher</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-ash block mb-1">
                      Dependencies (comma separated)
                    </label>
                    <input
                      type="text"
                      data-testid="new-task-deps"
                      value={newTaskForm.dependencies}
                      onChange={(e) =>
                        setNewTaskForm({
                          ...newTaskForm,
                          dependencies: e.target.value,
                        })
                      }
                      placeholder="T1, T2"
                      className="crypt-well w-full px-2.5 py-1.5 text-bone focus:outline-none focus:border-emerald-400/60"
                    />
                  </div>
                  <div>
                    <label className="text-ash block mb-1">
                      Files in Scope (comma separated)
                    </label>
                    <input
                      type="text"
                      data-testid="new-task-files"
                      value={newTaskForm.files}
                      onChange={(e) =>
                        setNewTaskForm({ ...newTaskForm, files: e.target.value })
                      }
                      placeholder="package.json, src/index.js"
                      className="crypt-well w-full px-2.5 py-1.5 text-bone focus:outline-none focus:border-emerald-400/60"
                    />
                  </div>
                  <div>
                    <label className="text-ash block mb-1">
                      Acceptance Command
                    </label>
                    <input
                      type="text"
                      data-testid="new-task-accept"
                      value={newTaskForm.acceptanceCommand}
                      onChange={(e) =>
                        setNewTaskForm({
                          ...newTaskForm,
                          acceptanceCommand: e.target.value,
                        })
                      }
                      className="crypt-well w-full px-2.5 py-1.5 text-bone focus:outline-none focus:border-emerald-400/60"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-4 pt-1">
                  <label className="flex items-center gap-2 text-parchment cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid="new-task-hard"
                      checked={newTaskForm.hard}
                      onChange={(e) =>
                        setNewTaskForm({ ...newTaskForm, hard: e.target.checked })
                      }
                      className="rounded border-white/20 bg-recessed"
                    />
                    <span>Hard task (requires Opus tier)</span>
                  </label>
                  <button
                    type="button"
                    data-testid="pact-btn-save-new-task"
                    onClick={handleAddNewTask}
                    className="crypt-btn-primary ml-auto px-4 py-1.5 rounded font-semibold text-xs"
                  >
                    Add Task
                  </button>
                </div>
              </div>
            )}

            {/* Tasks listing */}
            <div className="space-y-3">
              {tasks.length === 0 ? (
                <div className="crypt-well p-4 text-ash text-center">
                  No tasks currently in the Pact.
                </div>
              ) : (
                tasks.map((task) => {
                  const lockInfo = isTaskLocked(task);
                  const isDisabled = disabledTaskIds.includes(task.id);
                  const isEditing = editingTaskId === task.id;
                  const deps =
                    task.dependencies || task.depends || task.dependsOn || [];
                  const files = task.files || task.filesInScope || [];

                  return (
                    <div
                      key={task.id}
                      data-testid={`pact-task-item-${task.id}`}
                      className={`crypt-panel p-4 transition-colors ${
                        lockInfo.locked
                          ? "border-l-2 border-l-amber-400/70"
                          : isDisabled
                          ? "border-l-2 border-l-neutral-700 opacity-55"
                          : "border-l-2 border-l-emerald-500/50"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-2 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {/* Enable/Disable checkbox or locked indicator */}
                            <input
                              type="checkbox"
                              data-testid={`task-checkbox-${task.id}`}
                              checked={!isDisabled}
                              disabled={lockInfo.locked || mutationsLocked}
                              onChange={() => handleToggleTask(task.id)}
                              aria-label={`Include task ${task.id}: ${task.title}`}
                              className="rounded border-white/20 bg-recessed text-emerald-400"
                            />
                            <span className="font-bold text-bone text-xs">
                              {task.id}: {task.title}
                            </span>
                            <span className="px-2 py-0.5 rounded text-[10px] bg-recessed border border-white/10 text-parchment font-semibold uppercase tracking-wider">
                              {task.role}
                            </span>
                            {task.hard && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-950/60 border border-amber-500/40 text-amber-300 font-semibold">
                                Hard
                              </span>
                            )}
                            {lockInfo.locked && (
                              <span
                                data-testid={`task-locked-badge-${task.id}`}
                                title={lockInfo.reason}
                                className="px-1.5 py-0.5 rounded text-[10px] bg-amber-950/50 border border-amber-500/40 text-amber-300 font-bold"
                              >
                                [Locked]
                              </span>
                            )}
                          </div>

                          {/* Reason why it cannot be removed (Requirement 36.8) */}
                          {lockInfo.locked && lockInfo.reason && (
                            <p
                              data-testid={`task-locked-reason-${task.id}`}
                              className="text-ash text-[11px] leading-relaxed pl-5"
                            >
                              {lockInfo.reason}
                            </p>
                          )}

                          {/* Task details */}
                          <div className="text-[11px] text-ash space-y-1.5 pl-5">
                            {deps.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-dust">Dependencies:</span>
                                {deps.map((dep) => (
                                  <span
                                    key={dep}
                                    className="crypt-well px-2 py-0.5 text-[11px] text-parchment"
                                  >
                                    depends on: {dep}
                                  </span>
                                ))}
                              </div>
                            )}
                            {files.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-dust">Files:</span>
                                <span className="text-parchment">{files.join(", ")}</span>
                              </div>
                            )}
                            {task.acceptanceCommand && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-dust">Accept:</span>
                                <code className="crypt-well px-2 py-0.5 text-emerald-300/90">
                                  {task.acceptanceCommand}
                                </code>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Actions for non-locked task */}
                        {!lockInfo.locked && (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              data-testid={`task-btn-edit-${task.id}`}
                              onClick={() =>
                                setEditingTaskId(isEditing ? null : task.id)
                              }
                              disabled={mutationsLocked}
                              className="crypt-btn-ghost px-2.5 py-1 rounded text-[11px]"
                            >
                              {isEditing ? "Close" : "Edit"}
                            </button>
                            <button
                              type="button"
                              data-testid={`task-btn-delete-${task.id}`}
                              onClick={() => handleDeleteTask(task.id)}
                              disabled={mutationsLocked}
                              className="crypt-btn-danger px-2.5 py-1 rounded text-[11px]"
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Inline edit form */}
                      {isEditing && (
                        <div
                          data-testid={`task-edit-form-${task.id}`}
                          className="mt-3 pt-3 border-t border-white/[0.08] space-y-3"
                        >
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                            <div>
                              <label className="text-ash block mb-1">
                                Title
                              </label>
                              <input
                                type="text"
                                defaultValue={task.title}
                                id={`edit-title-${task.id}`}
                                className="crypt-well w-full px-2.5 py-1.5 text-bone focus:outline-none focus:border-emerald-400/60"
                              />
                            </div>
                            <div>
                              <label className="text-ash block mb-1">
                                Role
                              </label>
                              <select
                                defaultValue={task.role}
                                id={`edit-role-${task.id}`}
                                className="crypt-well w-full px-2.5 py-1.5 text-bone focus:outline-none focus:border-emerald-400/60"
                              >
                                <option value="bonesetter">bonesetter</option>
                                <option value="soul-stitcher">soul-stitcher</option>
                              </select>
                            </div>
                            <div>
                              <label className="text-ash block mb-1">
                                Dependencies
                              </label>
                              <input
                                type="text"
                                defaultValue={deps.join(", ")}
                                id={`edit-deps-${task.id}`}
                                className="crypt-well w-full px-2.5 py-1.5 text-bone focus:outline-none focus:border-emerald-400/60"
                              />
                            </div>
                            <div>
                              <label className="text-ash block mb-1">
                                Files in Scope
                              </label>
                              <input
                                type="text"
                                defaultValue={files.join(", ")}
                                id={`edit-files-${task.id}`}
                                className="crypt-well w-full px-2.5 py-1.5 text-bone focus:outline-none focus:border-emerald-400/60"
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <label className="text-ash block mb-1">
                                Acceptance Command
                              </label>
                              <input
                                type="text"
                                defaultValue={task.acceptanceCommand}
                                id={`edit-accept-${task.id}`}
                                className="crypt-well w-full px-2.5 py-1.5 text-bone focus:outline-none focus:border-emerald-400/60"
                              />
                            </div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingTaskId(null)}
                              className="crypt-btn-ghost px-3 py-1 rounded text-xs"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              data-testid={`task-btn-save-inline-${task.id}`}
                              onClick={() => {
                                const newTitle = (
                                  document.getElementById(
                                    `edit-title-${task.id}`
                                  ) as HTMLInputElement
                                )?.value;
                                const newRole = (
                                  document.getElementById(
                                    `edit-role-${task.id}`
                                  ) as HTMLSelectElement
                                )?.value as PactRole;
                                const newDeps = (
                                  document.getElementById(
                                    `edit-deps-${task.id}`
                                  ) as HTMLInputElement
                                )?.value;
                                const newFiles = (
                                  document.getElementById(
                                    `edit-files-${task.id}`
                                  ) as HTMLInputElement
                                )?.value;
                                const newAccept = (
                                  document.getElementById(
                                    `edit-accept-${task.id}`
                                  ) as HTMLInputElement
                                )?.value;

                                const updatedList = tasks.map((t) => {
                                  if (t.id === task.id) {
                                    const parsedDeps = newDeps
                                      ? newDeps
                                          .split(",")
                                          .map((s) => s.trim())
                                          .filter(Boolean)
                                      : [];
                                    const parsedFiles = newFiles
                                      ? newFiles
                                          .split(",")
                                          .map((s) => s.trim())
                                          .filter(Boolean)
                                      : [];
                                    return {
                                      ...t,
                                      title: newTitle || t.title,
                                      role: newRole || t.role,
                                      dependencies: parsedDeps,
                                      depends: parsedDeps,
                                      dependsOn: parsedDeps,
                                      files: parsedFiles,
                                      filesInScope: parsedFiles,
                                      acceptanceCommand:
                                        newAccept || t.acceptanceCommand,
                                      accept: newAccept || t.acceptanceCommand,
                                    };
                                  }
                                  return t;
                                });
                                setTasks(updatedList);
                                handleSaveEdits(updatedList);
                              }}
                              className="crypt-btn-primary px-3 py-1 rounded font-semibold text-xs"
                            >
                              Save Task
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Requirement 36.4: Uncovered Failures under "Not addressed by any task" */}
      {uncoveredFailures.length > 0 && (
        <div
          data-testid="uncovered-failures"
          className="crypt-panel border-l-2 border-l-rose-500 bg-rose-950/20 border-rose-500/35 p-4 space-y-3"
        >
          <div className="border-b border-rose-500/20 pb-2">
            <h3
              data-testid="uncovered-failures-heading"
              className="text-xs font-bold text-rose-300 uppercase tracking-wide"
            >
              Not addressed by any task
            </h3>
            <p className="text-ash text-[11px] mt-0.5">
              The following baseline failures detected in the death certificate are not covered by any enabled task.
            </p>
          </div>

          <div className="space-y-2">
            {uncoveredFailures.map((uf, idx) => (
              <div
                key={idx}
                data-testid={`uncovered-failure-${idx}`}
                className="crypt-well border-rose-500/25 p-3 text-parchment space-y-1 text-xs"
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-bold text-rose-300">
                    Step: {uf.step}
                  </span>
                  {uf.ruleId && (
                    <span className="px-1.5 py-0.5 rounded bg-crypt border border-white/10 text-ash">
                      Rule {uf.ruleId}
                    </span>
                  )}
                </div>
                <div className="text-bone">{uf.message}</div>
                {uf.excerpt && (
                  <pre className="text-[10px] text-ash bg-crypt p-2 rounded border border-white/10 overflow-x-auto">
                    {uf.excerpt}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Budget Settings Component (Requirements 36.11, 36.12, 36.13) */}
      <PactBudgetSettings
        ceiling={ceiling}
        budget={budget}
        onChange={setBudget}
        disabled={mutationsLocked || isApproving}
        creditsReported={false}
      />

      {/* Necromancer Consultation Channel */}
      {channelMessages.length > 0 && (
        <PactChannel messages={channelMessages} isDrafting={isRevising} />
      )}

      {/* Revision Request Form (Requirement 13.3) */}
      <div
        data-testid="pact-revision-panel"
        className="crypt-panel p-5 space-y-3"
      >
        <h3 className="text-xs font-semibold text-bone uppercase tracking-wide">
          Ask the Planner for a Revision
        </h3>
        <p className="text-ash text-[11px]">
          Describe what you want changed or added. The Planner will draft the revision.
        </p>
        <textarea
          data-testid="pact-revision-input"
          rows={2}
          value={revisionFeedback}
          onChange={(e) => setRevisionFeedback(e.target.value)}
          placeholder="e.g. Please add an acceptance check for python 3 syntax in tests."
          disabled={mutationsLocked}
          className="crypt-well w-full p-2.5 font-mono text-xs text-bone focus:outline-none focus:border-emerald-400/60 disabled:opacity-50"
        />
        <button
          type="button"
          data-testid="pact-btn-request-revision"
          onClick={handleRequestRevision}
          disabled={!revisionFeedback.trim() || mutationsLocked}
          className="crypt-btn-ghost px-4 py-1.5 rounded text-xs font-semibold"
        >
          {isRevising ? "Revising..." : "Request Revision"}
        </button>
      </div>

      {/* Approval and Final Controls (Requirements 36.7, 15.3) */}
      <div className="crypt-panel p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="text-ash text-xs">
          Approving starts the Legion phase and raises Skeletons according to the approved plan.
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid="pact-btn-approve-footer"
            onClick={handleApprove}
            disabled={isApproving || isRevising || isSavingEdit || isReadOnlyPhase}
            className="crypt-btn-primary px-5 py-2.5 rounded text-xs uppercase tracking-wider"
          >
            <CryptOrnament kind="wax-seal" className="w-4 h-4" />
            <span>
              {isApproving
                ? "Approving..."
                : isReadOnlyPhase
                ? isApproved
                  ? "Approved"
                  : "Locked"
                : "Seal & Approve Pact"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
