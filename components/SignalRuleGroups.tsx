"use client";

import React from "react";
import type { SignalChip as SignalChipType } from "@/lib/grimoire/autopsy";
import {
  groupSignalsByRule,
  type FileSignalGroup,
  type RuleSignalGroup,
} from "@/lib/ui/signal-groups";
import { SignalChip, type SignalChipData } from "./SignalChip";

type ChipLike = SignalChipType | SignalChipData;

export interface SignalRuleGroupsProps {
  chipsByRule: Readonly<Record<string, readonly ChipLike[] | null | undefined>>;
  ruleIds: readonly string[];
  sha?: string;
  onOpenReceipt?: (chip: ChipLike) => void;
}

const NO_FILE_LABEL = "file not recorded";

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function EmptyRuleRow({ ruleId }: { ruleId: string }) {
  return (
    <div
      data-testid={`rule-group-${ruleId}`}
      data-signal-count={0}
      className="px-3.5 py-1.5 rounded border border-dashed border-white/10 text-[11px] text-dust italic"
    >
      No signals detected for Rule {ruleId}.
    </div>
  );
}

interface FileRowProps {
  ruleId: string;
  group: FileSignalGroup<ChipLike>;
  sha?: string;
  onOpenReceipt?: (chip: ChipLike) => void;
}

function FileRow({ ruleId, group, sha, onOpenReceipt }: FileRowProps) {
  const fileLabel = group.hasFile ? group.file : NO_FILE_LABEL;
  return (
    <li
      data-testid="signal-file-row"
      data-file={group.file}
      data-signal-count={group.count}
      className="flex flex-col sm:flex-row sm:items-start gap-1.5 sm:gap-3 py-2 first:pt-0 last:pb-0"
    >
      <div className="sm:w-60 shrink-0 min-w-0 flex items-baseline gap-2 pt-0.5">
        <code
          data-testid="signal-file-path"
          className={`text-xs break-all ${group.hasFile ? "text-bone" : "text-dust italic"}`}
        >
          {fileLabel}
        </code>
        <span className="text-[10px] text-dust whitespace-nowrap tabular-nums">
          {countLabel(group.count, "signal")}
        </span>
      </div>
      <ul
        aria-label={`Rule ${ruleId} receipts in ${fileLabel}`}
        className="flex flex-wrap gap-1.5 min-w-0"
      >
        {group.signals.map((chip, idx) => (
          <li key={`${group.file}-${chip.line}-${idx}`}>
            <SignalChip
              chip={chip}
              sha={sha}
              variant="line"
              onOpenReceipt={onOpenReceipt}
            />
          </li>
        ))}
      </ul>
    </li>
  );
}

interface RuleSectionProps {
  group: RuleSignalGroup<ChipLike>;
  sha?: string;
  onOpenReceipt?: (chip: ChipLike) => void;
}

function RuleSection({ group, sha, onOpenReceipt }: RuleSectionProps) {
  const headingId = `rule-group-heading-${group.ruleId}`;
  return (
    <section
      data-testid={`rule-group-${group.ruleId}`}
      data-signal-count={group.count}
      aria-labelledby={headingId}
      className="crypt-panel p-3.5 space-y-2.5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-ash">
        <h4 id={headingId} className="font-bold text-bone">
          Rule {group.ruleId}
        </h4>
        <span className="text-[10px] text-dust tabular-nums">
          {countLabel(group.count, "signal")} in{" "}
          {countLabel(group.files.length, "file")}
        </span>
      </div>
      <ul className="divide-y divide-white/5">
        {group.files.map((fileGroup) => (
          <FileRow
            key={fileGroup.file || "(no file)"}
            ruleId={group.ruleId}
            group={fileGroup}
            sha={sha}
            onOpenReceipt={onOpenReceipt}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Signal_Chips grouped by rule (Requirement 5.3), then by file. Every
 * `file:line` receipt is rendered as its own copyable chip (Requirements 5.4
 * and 5.6); rules without signals collapse to one short line.
 */
export function SignalRuleGroups({
  chipsByRule,
  ruleIds,
  sha,
  onOpenReceipt,
}: SignalRuleGroupsProps) {
  const groups = groupSignalsByRule(chipsByRule, ruleIds);
  return (
    <div className="space-y-2" data-testid="grouped-signal-chips">
      {groups.map((group) =>
        group.count === 0 ? (
          <EmptyRuleRow key={group.ruleId} ruleId={group.ruleId} />
        ) : (
          <RuleSection
            key={group.ruleId}
            group={group}
            sha={sha}
            onOpenReceipt={onOpenReceipt}
          />
        )
      )}
    </div>
  );
}
