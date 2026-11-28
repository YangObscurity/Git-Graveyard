#!/usr/bin/env tsx
// WP-29 Task 29.2: Security access audit runner (CLI + library).
//
// Supports `--phase G1` (pre-promotion items) and `--phase G3` (post-promotion items
// marked `post`, plus the RP repository-privacy verification hook that reports whether a
// clean privacy scan report is attached). Evidence is written via evidence-recorder.ts
// (one file per item id) and a structured exit status is returned.

import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  type AuditConclusion,
  type AuditItemId,
  type AuditPhase,
  type AuditValidationResult,
  isAuditPhase,
  requiredItemIdsForPhase,
  validateAuditDocument,
} from "../../lib/audit/audit-schema";
import {
  type EvidenceRecordResult,
  auditEvidenceDir,
  recordEvidenceItem,
} from "../../lib/audit/evidence-recorder";

export interface AuditItemRunInput {
  id: AuditItemId;
  conclusion: AuditConclusion;
  owner: string;
  rationale?: string;
  /** Content recorded as the item's evidence (never raw secrets). */
  evidence?: unknown;
}

export interface PrivacyScanHook {
  /** True when a privacy scan report is attached to the audit. */
  attached: boolean;
  /** True when the attached scan is clean (no findings). */
  clean: boolean;
  reportPath?: string;
}

export interface RunSecurityAuditOptions {
  phase: AuditPhase;
  /** Workspace root; evidence lands beneath `<baseDir>/01_evidence/audit-<date>/`. */
  baseDir: string;
  actor: string;
  items: readonly AuditItemRunInput[];
  /** ISO date (YYYY-MM-DD); defaults to the current UTC date. */
  date?: string;
  /** RP repository-privacy hook (only meaningful for `G3`). */
  privacyScan?: PrivacyScanHook;
}

export interface RunSecurityAuditResult {
  ok: boolean;
  phase: AuditPhase;
  exitCode: number;
  date: string;
  evidenceDir: string;
  recorded: EvidenceRecordResult[];
  validation: AuditValidationResult;
  privacy: { required: boolean; attached: boolean; clean: boolean } | null;
  failures: string[];
}

function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Runs a security audit for a phase: validates the item conclusions, records one
 * evidence file per item id and (for `G3`) applies the RP privacy hook. Returns a
 * structured result whose `exitCode` is `0` only when the audit fully passes.
 */
export function runSecurityAudit(options: RunSecurityAuditOptions): RunSecurityAuditResult {
  const phase = options.phase;
  const date = options.date ?? utcDate();
  const actor = options.actor;
  const items = Array.isArray(options.items) ? options.items : [];

  const doc = {
    phase,
    actor,
    items: items.map((item) => ({
      id: item.id,
      conclusion: item.conclusion,
      owner: item.owner,
      rationale: item.rationale,
    })),
  };
  const validation = validateAuditDocument(doc);

  const recorded: EvidenceRecordResult[] = [];
  for (const item of items) {
    recorded.push(
      recordEvidenceItem({
        baseDir: options.baseDir,
        date,
        itemId: item.id,
        actor,
        phase,
        content:
          item.evidence ??
          ({
            conclusion: item.conclusion,
            owner: item.owner,
            rationale: item.rationale ?? null,
          } as Record<string, unknown>),
      })
    );
  }

  let privacy: RunSecurityAuditResult["privacy"] = null;
  const failures: string[] = validation.errors.map((error) => error.message);

  if (phase === "G3") {
    const attached = options.privacyScan?.attached === true;
    const clean = options.privacyScan?.clean === true;
    privacy = { required: true, attached, clean };
    if (!attached) {
      failures.push(
        "G3 audit requires an attached RP repository-privacy scan report; none was attached."
      );
    } else if (!clean) {
      failures.push(
        "G3 audit RP repository-privacy scan report is attached but not clean."
      );
    }
  }

  const ok = validation.ok && failures.length === 0;
  return {
    ok,
    phase,
    exitCode: ok ? 0 : 1,
    date,
    evidenceDir: auditEvidenceDir(options.baseDir, date),
    recorded,
    validation,
    privacy,
    failures,
  };
}

/** Builds default `Pass` items for every item required by a phase (CLI convenience). */
export function defaultPassingItems(
  phase: AuditPhase,
  actor: string
): AuditItemRunInput[] {
  return requiredItemIdsForPhase(phase).map((id) => ({
    id,
    conclusion: "Pass" as AuditConclusion,
    owner: actor,
    evidence: { note: "auto-generated pass placeholder" },
  }));
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

interface CliArgs {
  phase: AuditPhase;
  baseDir: string;
  date?: string;
  actor: string;
  inputPath?: string;
  privacyReport?: string;
  privacyClean: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    phase: "G1",
    baseDir: process.cwd(),
    actor: "owner",
    privacyClean: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (): string => {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return next;
    };
    switch (arg) {
      case "--phase":
        args.phase = takeValue() as AuditPhase;
        break;
      case "--base-dir":
        args.baseDir = takeValue();
        break;
      case "--date":
        args.date = takeValue();
        break;
      case "--actor":
        args.actor = takeValue();
        break;
      case "--input":
        args.inputPath = takeValue();
        break;
      case "--privacy-report":
        args.privacyReport = takeValue();
        break;
      case "--privacy-clean":
        args.privacyClean = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const USAGE = `Usage: run-security-audit --phase <G1|G3> [options]

  --phase <G1|G3>       Audit phase (default: G1).
  --base-dir <path>     Workspace root for 01_evidence (default: cwd).
  --date <YYYY-MM-DD>   Evidence date segment (default: today UTC).
  --actor <name>        Signing actor (default: owner).
  --input <file.json>   JSON array of item run inputs (default: auto Pass items).
  --privacy-report <p>  Attach an RP privacy scan report path (G3).
  --privacy-clean       Mark the attached privacy scan as clean (G3).
  --help                Show this help.`;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!isAuditPhase(args.phase)) {
    process.stderr.write(`Invalid --phase '${args.phase}'; expected G1 or G3.\n`);
    return 2;
  }

  let items: AuditItemRunInput[];
  if (args.inputPath) {
    const raw = fs.readFileSync(path.resolve(args.inputPath), "utf8");
    items = JSON.parse(raw) as AuditItemRunInput[];
  } else {
    items = defaultPassingItems(args.phase, args.actor);
  }

  const result = runSecurityAudit({
    phase: args.phase,
    baseDir: args.baseDir,
    actor: args.actor,
    items,
    date: args.date,
    privacyScan:
      args.phase === "G3"
        ? {
            attached: Boolean(args.privacyReport),
            clean: args.privacyClean,
            reportPath: args.privacyReport,
          }
        : undefined,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.exitCode;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
      process.exitCode = 1;
    });
}