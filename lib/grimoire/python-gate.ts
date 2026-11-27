// lib/grimoire/python-gate.ts
// Requirements 9.1-9.4, 9.10, 9.11, 9.13; design R3-9 (Python monotone gate).
import type { Tree } from "web-tree-sitter";
import type { EventEnvelope, EvidenceRef } from "../events/types";
import type { UnknownRecord } from "./types";
import type { EventInput, GateResult, PatchStep } from "./gate-js";
import { isPythonFile, normalizeFilePath } from "./gate-js";
import {
  M1_RULE_ID,
  applyEditsToOriginal,
  countHunks,
  countPythonResidue,
  createPythonDiff,
  initPythonParser,
  parsePython,
  type PythonPlannedEdit,
} from "../rules/m1-python";

export type PythonRejectReason =
  | "parse_timeout"
  | "gate_errors_rose"
  | "gate_residue_not_reduced";

export interface PythonRejectedEdit {
  edit: PythonPlannedEdit;
  reason: PythonRejectReason;
}

export interface PythonGateFileResult {
  file: string;
  original: string;
  text: string;
  label: "m1-clean" | "m1-partial";
  accepted: PythonPlannedEdit[];
  rejected: PythonRejectedEdit[];
  errorsBefore: number;
  errorsAfter: number;
  residueBefore: number;
  residueAfter: number;
  reverted: boolean;
  revertReason?: string;
  unknowns: UnknownRecord[];
  step: PatchStep;
}

export interface PythonGateOptions {
  file?: string;
  /** Parse override, used to simulate parse timeouts in tests. */
  parse?: (source: string) => Tree | null;
  runId?: string;
  taskId?: string;
  actor?: string;
  refs?: EvidenceRef[];
  eventStore?: {
    append(input: EventInput): EventEnvelope;
    [key: string]: unknown;
  };
  emit?: (event: unknown) => void;
  [key: string]: unknown;
}

/** Counts AST nodes that are syntax errors or missing placeholders. */
export function errorCount(tree: Tree): number {
  let count = 0;
  const stack = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) count += 1;
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
  return count;
}

function buildStep(
  file: string,
  original: string,
  text: string,
  accepted: PythonPlannedEdit[],
  ordered: PythonPlannedEdit[],
  reverted: boolean,
  revertReason?: string
): PatchStep {
  const diff = accepted.length > 0 ? createPythonDiff(original, text, file) : "";
  return {
    id: `M1:${file}`,
    ruleId: M1_RULE_ID,
    file,
    diff,
    hunks: countHunks(diff),
    compat: false,
    reverted,
    revertReason: reverted ? revertReason ?? "all_edits_rejected" : undefined,
    acceptedEdits: accepted.length,
    acceptedEditsCount: accepted.length,
    edits: ordered,
    plannedEdits: ordered,
  };
}

function runGate(
  original: string,
  edits: PythonPlannedEdit[],
  parse: (source: string) => Tree | null,
  options?: PythonGateOptions
): PythonGateFileResult {
  const file = normalizeFilePath(options?.file ?? "file.py");
  const unknowns: UnknownRecord[] = [];
  const ordered = [...(edits ?? [])].sort(
    (a, b) => a.start - b.start || a.ruleOrder - b.ruleOrder
  );

  const t0 = parse(original);
  if (!t0) {
    unknowns.push({ ruleId: M1_RULE_ID, reason: "parse_timeout", file });
    return {
      file,
      original,
      text: original,
      label: "m1-partial",
      accepted: [],
      rejected: ordered.map((edit) => ({ edit, reason: "parse_timeout" as const })),
      errorsBefore: 0,
      errorsAfter: 0,
      residueBefore: 0,
      residueAfter: 0,
      reverted: true,
      revertReason: "parse_timeout",
      unknowns,
      step: buildStep(file, original, original, [], ordered, true, "parse_timeout"),
    };
  }

  try {
    const errorsBefore = errorCount(t0);
    const residueBefore = countPythonResidue(t0);
    let err = errorsBefore;
    let res = residueBefore;
    const accepted: PythonPlannedEdit[] = [];
    const rejected: PythonRejectedEdit[] = [];

    for (const edit of ordered) {
      const candidateText = applyEditsToOriginal(original, [...accepted, edit]);
      const tree = parse(candidateText);
      if (!tree) {
        rejected.push({ edit, reason: "parse_timeout" });
        unknowns.push({
          ruleId: M1_RULE_ID,
          reason: "parse_timeout",
          file,
          line: edit.line,
        });
        continue;
      }
      try {
        const nextErrors = errorCount(tree);
        const nextResidue = countPythonResidue(tree);
        if (nextErrors <= err && nextResidue < res) {
          accepted.push(edit);
          err = nextErrors;
          res = nextResidue;
        } else {
          const reason: PythonRejectReason =
            nextErrors > err ? "gate_errors_rose" : "gate_residue_not_reduced";
          rejected.push({ edit, reason });
          unknowns.push({
            ruleId: M1_RULE_ID,
            reason,
            file,
            line: edit.line,
          });
        }
      } finally {
        tree.delete?.();
      }
    }

    const text = applyEditsToOriginal(original, accepted);
    const reverted = ordered.length > 0 && accepted.length === 0;

    return {
      file,
      original,
      text,
      label: res === 0 ? "m1-clean" : "m1-partial",
      accepted,
      rejected,
      errorsBefore,
      errorsAfter: err,
      residueBefore,
      residueAfter: res,
      reverted,
      revertReason: reverted ? "all_edits_rejected" : undefined,
      unknowns,
      step: buildStep(
        file,
        original,
        text,
        accepted,
        ordered,
        reverted,
        reverted ? "all_edits_rejected" : undefined
      ),
    };
  } finally {
    t0.delete?.();
  }
}

/** Synchronous gate; requires the Python parser to be initialized. */
export function gatePythonSync(
  original: string,
  edits: PythonPlannedEdit[],
  options?: PythonGateOptions
): PythonGateFileResult {
  const parse = options?.parse ?? parsePython;
  return runGate(original, edits, parse, options);
}

/** Requirement 9.1-9.4: monotone per-file Python gate. */
export async function gatePython(
  original: string,
  edits: PythonPlannedEdit[],
  options?: PythonGateOptions
): Promise<PythonGateFileResult> {
  if (!options?.parse) await initPythonParser();
  return gatePythonSync(original, edits, options);
}

// ---------------------------------------------------------------------------
// Candidate verification (Requirement 9.10, 9.11, 9.13)
// ---------------------------------------------------------------------------

export type PythonFileCollection =
  | Array<{ path: string; content: string }>
  | Record<string, string>
  | Map<string, string>
  | { files?: Array<{ path: string; content: string }> }
  | null
  | undefined;

export interface PythonCandidateGateInput {
  before?: PythonFileCollection;
  after?: PythonFileCollection;
  head?: PythonFileCollection;
  candidate?: PythonFileCollection;
  files?: PythonFileCollection;
  changedFiles?: string[];
  deletions?: string[];
  deletedFiles?: string[];
  tree?: string;
  candidateTree?: string;
}

export interface PythonCandidateGateOptions {
  runId?: string;
  taskId?: string;
  actor?: string;
  refs?: EvidenceRef[];
  head?: PythonFileCollection;
  deletions?: string[];
  deletedFiles?: string[];
  tree?: string;
  candidateTree?: string;
  eventStore?: {
    append(input: EventInput): EventEnvelope;
    [key: string]: unknown;
  };
  emit?: (event: unknown) => void;
  [key: string]: unknown;
}

function collectFiles(collection: PythonFileCollection): Map<string, string> {
  const out = new Map<string, string>();
  if (!collection) return out;
  if (collection instanceof Map) {
    for (const [path, content] of collection.entries()) {
      if (typeof content === "string") out.set(normalizeFilePath(path), content);
    }
    return out;
  }
  if (Array.isArray(collection)) {
    for (const entry of collection) {
      if (entry && typeof entry.path === "string" && typeof entry.content === "string") {
        out.set(normalizeFilePath(entry.path), entry.content);
      }
    }
    return out;
  }
  if (typeof collection === "object") {
    if (Array.isArray((collection as { files?: unknown }).files)) {
      for (const entry of (collection as { files: Array<{ path: string; content: string }> }).files) {
        if (entry && typeof entry.path === "string" && typeof entry.content === "string") {
          out.set(normalizeFilePath(entry.path), entry.content);
        }
      }
      return out;
    }
    for (const [path, content] of Object.entries(collection as Record<string, unknown>)) {
      if (typeof content === "string") out.set(normalizeFilePath(path), content);
    }
  }
  return out;
}

function changedPythonFiles(
  before: Map<string, string>,
  after: Map<string, string>,
  explicit?: string[],
  deletions?: Set<string>
): string[] {
  const changed = new Set<string>();
  if (Array.isArray(explicit)) {
    for (const path of explicit) {
      const norm = normalizeFilePath(path);
      if (isPythonFile(norm)) changed.add(norm);
    }
  }
  if (deletions) {
    for (const path of deletions) {
      if (isPythonFile(path)) changed.add(path);
    }
  }
  for (const [path, content] of after.entries()) {
    if (!isPythonFile(path)) continue;
    if (!before.has(path) || before.get(path) !== content) changed.add(path);
  }
  return Array.from(changed).sort();
}

/**
 * Requirement 9.10-9.13: verifies every changed Python file in a Candidate
 * against the Integration_Head. Failures are returned as gate reasons so the
 * Builder can be given feedback without reaching Warden review.
 */
export async function checkPythonCandidateGate(
  input: PythonCandidateGateInput,
  options?: PythonCandidateGateOptions
): Promise<GateResult> {
  await initPythonParser();

  // Never fall back `before` to `input.files`: missing baseline means empty
  // baseline so new Py2-residue files cannot pass via self-comparison.
  const before = collectFiles(
    input?.before ?? input?.head ?? options?.head
  );
  const after = collectFiles(
    input?.after ?? input?.candidate ?? input?.files
  );

  const deletionSet = new Set<string>();
  const rawDeletions = [
    ...(Array.isArray(input?.deletions) ? input.deletions : []),
    ...(Array.isArray(input?.deletedFiles) ? input.deletedFiles : []),
    ...(Array.isArray(options?.deletions) ? options.deletions : []),
    ...(Array.isArray(options?.deletedFiles) ? options.deletedFiles : []),
  ];
  for (const p of rawDeletions) {
    const norm = normalizeFilePath(p);
    if (isPythonFile(norm)) deletionSet.add(norm);
  }

  const files = changedPythonFiles(before, after, input?.changedFiles, deletionSet);
  const reasons: string[] = [];
  const details: Record<
    string,
    { ok: boolean; mode?: "script" | "module"; error?: string }
  > = {};

  for (const file of files) {
    const afterContent = after.get(file);
    if (afterContent === undefined) {
      if (before.has(file) || deletionSet.has(file)) {
        // Valid deleted file: nothing to parse.
        details[file] = { ok: true };
      } else {
        const errMsg = "content not supplied";
        reasons.push(`${file}: ${errMsg}`);
        details[file] = { ok: false, error: errMsg };
      }
      continue;
    }
    const beforeContent = before.get(file) ?? "";
    const beforeTree = parsePython(beforeContent);
    const afterTree = parsePython(afterContent);
    if (!afterTree) {
      beforeTree?.delete?.();
      reasons.push(`${file}: parse_timeout`);
      details[file] = { ok: false, error: "parse_timeout" };
      continue;
    }
    try {
      const errorsBefore = beforeTree ? errorCount(beforeTree) : 0;
      const residueBefore = beforeTree ? countPythonResidue(beforeTree) : 0;
      const errorsAfter = errorCount(afterTree);
      const residueAfter = countPythonResidue(afterTree);

      if (errorsAfter > errorsBefore) {
        reasons.push(`${file}: gate_errors_rose`);
        details[file] = { ok: false, error: "gate_errors_rose" };
      } else if (residueAfter > residueBefore) {
        reasons.push(`${file}: gate_residue_not_reduced`);
        details[file] = { ok: false, error: "gate_residue_not_reduced" };
      } else {
        details[file] = { ok: true };
      }
    } finally {
      beforeTree?.delete?.();
      afterTree.delete?.();
    }
  }

  const ok = reasons.length === 0;
  const tree =
    input?.tree ??
    input?.candidateTree ??
    options?.tree ??
    options?.candidateTree;
  const result: GateResult = {
    ok,
    files,
    reasons,
    gate: "syntax",
    kind: "gate.result",
    details,
    ...(tree !== undefined ? { tree } : {}),
  };

  const actor = options?.actor ?? "grimoire";
  const data = {
    gate: "syntax" as const,
    language: "python",
    ok,
    files,
    reasons,
    refs: options?.refs ?? [],
    // Carry the candidate tree SHA on the event when supplied so gate.result
    // events correlate with the GateResult and the reviewed candidate tree.
    // Omit the key entirely when no tree was provided (no `tree: undefined`).
    ...(tree !== undefined ? { tree } : {}),
  };

  if (options?.eventStore && typeof options.eventStore.append === "function") {
    options.eventStore.append({
      runId: options?.runId ?? "run-gate",
      kind: "gate.result",
      actor,
      taskId: options?.taskId ?? null,
      attempt: null,
      data,
    });
  }
  if (typeof options?.emit === "function") {
    options.emit({ kind: "gate.result", actor, data });
  }

  return result;
}

