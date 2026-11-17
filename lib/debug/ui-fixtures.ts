import type { HealthBadgeProps } from "@/components/HealthBadge";
import type { StatusPillProps } from "@/components/ui/StatusPill";
import type { SignalChipData } from "@/components/SignalChip";
import type { CommandRowItem } from "@/components/CommandRow";
import type { DeathCertificate } from "@/lib/exhume/death-certificate";
import type { PactBudgetSettingsProps } from "@/components/PactBudgetSettings";
import type { PactDiffProps } from "@/components/PactDiff";
import type { PactEditorProps } from "@/components/PactEditor";
import type { PactTask } from "@/lib/pact/pact-parser";
import type { LegionRunHeaderProps } from "@/components/LegionRunHeader";
import type { SkeletonData } from "@/components/LegionSkeletonCard";
import type { LegionWaitingRoomCardProps } from "@/components/LegionWaitingRoomCard";
import type { ApprovalData } from "@/components/LegionApprovalCard";
import type { AskData } from "@/components/LegionAskCard";
import type { ReliquaryViewProps } from "@/components/ReliquaryView";
import type { ReliquaryBeforeAfterTableProps } from "@/components/ReliquaryBeforeAfterTable";
import type { ReliquaryArtifactDownloadsProps, ReliquaryArtifactItem } from "@/components/ReliquaryArtifactDownloads";

export type DebugPresetMode =
  | "loading"
  | "empty"
  | "active"
  | "blocked"
  | "failed"
  | "resurrected";

export const DEBUG_PRESET_MODES: readonly DebugPresetMode[] = [
  "loading",
  "empty",
  "active",
  "blocked",
  "failed",
  "resurrected",
] as const;

export type DebugViewportMode = "full" | "tablet" | "mobile";

export const DEBUG_VIEWPORT_MODES: readonly DebugViewportMode[] = [
  "full",
  "tablet",
  "mobile",
] as const;

export const SHOWCASE_SECTIONS = [
  { id: "tokens", label: "1. Tokens & Ornaments" },
  { id: "badges", label: "2. Badges, Signals & Rows" },
  { id: "tomb", label: "3. Tomb & Autopsy" },
  { id: "pact", label: "4. Pact Workbench" },
  { id: "legion", label: "5. Legion Tactical" },
  { id: "reliquary", label: "6. Reliquary & Vault" },
] as const;

export type ShowcaseSectionId = (typeof SHOWCASE_SECTIONS)[number]["id"];

const FIXED_NOW_MS = 1731672000000;
const FIXED_ISO = "2024-11-15T12:00:00.000Z";

export const SYNTHETIC_SHA_A =
  "a4f9c28e1b7d3056e94a21c8f0b73d65a1e4c982d3f07b64c5a8e1209d3f4b7c";
export const SYNTHETIC_SHA_B =
  "b8d1e409f2a6c731d58e90a4b2c7f613e8d40a59c1b3e7f2a6d804c9e1b5a23f";
export const SYNTHETIC_SHA_C =
  "c29e74b108d5a3f67b41c920e5a8d314f7b6029e4c81a5d3b7e09f42a6c1d835";
export const SYNTHETIC_SHA_D =
  "d713a9f452c8e06b34d17a85f2c90e4b6a13d872f5c04e91b2a6d380f4c7e519";

export const THEME_SWATCHES = [
  { name: "--bg-abyss", hex: "#060709", role: "Page backdrop" },
  { name: "--bg-crypt", hex: "#0b0d11", role: "Primary slab" },
  { name: "--bg-slab", hex: "#10131a", role: "Elevated card" },
  { name: "--bg-recessed", hex: "#050608", role: "Terminal well" },
  { name: "--fg-bone", hex: "#f5f5f4", role: "Primary headings" },
  { name: "--fg-parchment", hex: "#d6d3d1", role: "Body copy" },
  { name: "--necromancy-emerald", hex: "#10b981", role: "Primary CTA / pass" },
  { name: "--arcane-amber", hex: "#f59e0b", role: "Queue / approval" },
  { name: "--crimson-seal", hex: "#f43f5e", role: "Failure / seal" },
  { name: "--spectral-violet", hex: "#a78bfa", role: "Pact / info" },
] as const;

export interface UiShowcaseFixtureBundle {
  preset: DebugPresetMode;
  healthBadges: HealthBadgeProps[];
  statusPills: StatusPillProps[];
  signalChips: SignalChipData[];
  commandRows: CommandRowItem[];
  deathCertificate: DeathCertificate;
  receiptChip: SignalChipData;
  pactBudget: PactBudgetSettingsProps;
  pactDiff: PactDiffProps;
  pactEditorValid: NonNullable<PactEditorProps["initialData"]>;
  pactEditorWithCycle: NonNullable<PactEditorProps["initialData"]>;
  legionHeader: LegionRunHeaderProps;
  skeletons: SkeletonData[];
  waitingRoom: LegionWaitingRoomCardProps;
  approval: ApprovalData;
  ask: AskData;
  reliquaryView: ReliquaryViewProps;
  beforeAfterTable: ReliquaryBeforeAfterTableProps;
  artifactDownloads: ReliquaryArtifactDownloadsProps;
}

function makeBasePactTasks(withCycle: boolean): PactTask[] {
  return [
    {
      id: "T1",
      title: "Restore lockfile and pin compatible Node runtime",
      role: "bonesetter",
      dependencies: withCycle ? ["T2"] : [],
      depends: withCycle ? ["T2"] : [],
      dependsOn: withCycle ? ["T2"] : [],
      files: ["package.json", "package-lock.json"],
      filesInScope: ["package.json", "package-lock.json"],
      acceptanceCommand: "npm ci --ignore-scripts",
      accept: "npm ci --ignore-scripts",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      ruleIds: ["M1", "M3"],
      rules: ["M1", "M3"],
      line: 12,
    },
    {
      id: "T2",
      title: "Replace deprecated Buffer constructor in parser",
      role: "bonesetter",
      dependencies: ["T1"],
      depends: ["T1"],
      dependsOn: ["T1"],
      files: ["src/parser.ts"],
      filesInScope: ["src/parser.ts"],
      acceptanceCommand: "npm run build",
      accept: "npm run build",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      ruleIds: ["M2"],
      rules: ["M2"],
      line: 24,
    },
    {
      id: "warden_final_check",
      title: "Warden Final Check & Regression Suite",
      role: "soul-stitcher",
      dependencies: ["T2"],
      depends: ["T2"],
      dependsOn: ["T2"],
      files: ["test/parser.test.ts"],
      filesInScope: ["test/parser.test.ts"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: true,
      hardFlag: true,
      hardRaw: "yes",
      ruleIds: ["M1", "M4"],
      rules: ["M1", "M4"],
      line: 36,
    },
  ];
}

function makeDeathCertificate(preset: DebugPresetMode): DeathCertificate {
  const isResurrected = preset === "resurrected";
  return {
    schemaVersion: "v1",
    baseSha: "9f3c1b2a84e7d601",
    runId: "debug-run-01",
    repoUrl: "https://github.com/acme-crypt/legacy-ledger",
    primaryLanguage: "node",
    packageManager: "npm",
    createdAt: FIXED_ISO,
    healthy: isResurrected,
    rows: [
      {
        step: "version",
        command: "node -v",
        status: "passed",
        exitCode: 0,
        durationMs: 42,
      },
      {
        step: "install",
        command: "npm install --ignore-scripts",
        status: isResurrected ? "passed" : "failed",
        exitCode: isResurrected ? 0 : 1,
        durationMs: 3240,
        errorExcerpt: isResurrected
          ? undefined
          : "ERESOLVE unable to resolve dependency tree for typescript@3.9.10",
      },
      {
        step: "build",
        command: "npm run build",
        status: isResurrected ? "passed" : "not run",
        exitCode: isResurrected ? 0 : null,
        durationMs: isResurrected ? 1850 : undefined,
        reason: isResurrected ? undefined : "Skipped after install failure",
      },
      {
        step: "test",
        command: "npm test",
        status: isResurrected ? "passed" : "No tests found",
        exitCode: isResurrected ? 0 : null,
        ruleId: isResurrected ? undefined : "M13",
      },
    ],
    runtimes: [
      {
        step: "version",
        command: "node -v",
        status: "passed",
        exitCode: 0,
        durationMs: 42,
      },
    ],
    install: {
      step: "install",
      command: "npm install --ignore-scripts",
      status: isResurrected ? "passed" : "failed",
      exitCode: isResurrected ? 0 : 1,
      durationMs: 3240,
    },
    build: {
      step: "build",
      command: "npm run build",
      status: isResurrected ? "passed" : "not run",
      exitCode: isResurrected ? 0 : null,
    },
    test: {
      step: "test",
      command: "npm test",
      status: isResurrected ? "passed" : "No tests found",
      exitCode: isResurrected ? 0 : null,
      ruleId: isResurrected ? undefined : "M13",
    },
    failureClasses: isResurrected
      ? []
      : ["DEPENDENCY_RESOLUTION_FAILURE", "RUNTIME_API_REMOVED"],
    failures: isResurrected
      ? []
      : [
          {
            class: "DEPENDENCY_RESOLUTION_FAILURE",
            step: "install",
            message: "Peer dependency conflict in package.json:42",
            excerpt: "ERESOLVE unable to resolve dependency tree",
            ref: "package.json:42",
            ruleId: "M1",
          },
          {
            class: "RUNTIME_API_REMOVED",
            step: "build",
            message: "Deprecated Buffer() constructor flagged in src/parser.ts:88",
            ref: "src/parser.ts:88",
            ruleId: "M2",
          },
        ],
    sha256: SYNTHETIC_SHA_D,
    summary: isResurrected
      ? "Repository verified healthy across install, build, and test probes."
      : "Abandoned Node.js package stalled by lockfile drift and removed runtime APIs.",
  };
}

const REALISTIC_ARTIFACTS: ReliquaryArtifactItem[] = [
  {
    id: "patch",
    name: "Resurrection Diff Patch",
    fileName: "all.patch",
    kind: "patch",
    size: 4820,
    sha256: SYNTHETIC_SHA_A,
    content: "--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -86,2 +86,2 @@\n-  return new Buffer(raw);\n+  return Buffer.from(raw);\n",
  },
  {
    id: "spec",
    name: "Necromancer Pact Spec",
    fileName: "pact.md",
    kind: "spec",
    size: 1640,
    sha256: SYNTHETIC_SHA_B,
  },
  {
    id: "report",
    name: "Scribe Forensic Report",
    fileName: "report.md",
    kind: "report",
    size: 3110,
    sha256: SYNTHETIC_SHA_C,
  },
  {
    id: "certificate",
    name: "Death Certificate",
    fileName: "death-certificate.json",
    kind: "certificate",
    size: 2048,
    sha256: SYNTHETIC_SHA_D,
  },
];

export function getUiFixturesForPreset(
  preset: DebugPresetMode
): UiShowcaseFixtureBundle {
  const cert = makeDeathCertificate(preset);
  const validTasks = makeBasePactTasks(false);
  const cycleTasks = makeBasePactTasks(true);

  const healthBadges: HealthBadgeProps[] = [
    { loading: preset === "loading", status: "open" },
    { loading: false, status: "queue length", queueLength: 3 },
    { loading: false, status: "paused by owner" },
    { loading: false, status: "unavailable" },
  ];

  const statusPills: StatusPillProps[] = [
    { tone: "emerald", pulse: preset === "active", label: "Resurrected", uiState: "resurrected" },
    { tone: "amber", pulse: preset === "blocked", label: "Awaiting Approval", uiState: "blocked" },
    { tone: "crimson", label: "Gate Rejected", uiState: "failed" },
    { tone: "violet", label: "Pact Draft v2", uiState: "draft" },
    { tone: "neutral", label: "Not Run", uiState: "not-run" },
  ];

  const signalChips: SignalChipData[] = [
    {
      ruleId: "M1",
      file: "package.json",
      line: 42,
      target: "package.json:42",
      confidence: "high",
      snippet: '"typescript": "^3.9.10"',
    },
    {
      ruleId: "M2",
      file: "src/parser.ts",
      line: 88,
      target: "src/parser.ts:88",
      confidence: "high",
      snippet: "return new Buffer(rawInput);",
    },
    {
      ruleId: "M3",
      file: "src/config.ts",
      line: 19,
      target: "src/config.ts:19",
      confidence: "medium",
      snippet: "const legacyPort = process.env.PORT || 8080;",
    },
    {
      ruleId: "M5",
      file: "README.md",
      line: 7,
      target: "README.md:7",
      confidence: "low",
      snippet: "Tested on Node 12 LTS.",
    },
  ];

  const commandRows: CommandRowItem[] = [
    {
      id: "cmd-1",
      step: "install",
      command: "npm ci --ignore-scripts",
      status: preset === "loading" || preset === "active" ? "running" : "passed",
      exitCode: preset === "loading" || preset === "active" ? null : 0,
      durationMs: 2450,
      output: "added 142 packages in 2.4s",
    },
    {
      id: "cmd-2",
      step: "build",
      command: "npm run build",
      status: preset === "failed" ? "failed" : "passed",
      exitCode: preset === "failed" ? 2 : 0,
      durationMs: 1840,
      errorExcerpt:
        preset === "failed"
          ? "src/parser.ts(88,10): error TS2304: Cannot find name 'Buffer'."
          : undefined,
      output:
        preset === "failed"
          ? "src/parser.ts(88,10): error TS2304: Cannot find name 'Buffer'."
          : "tsc --noEmit: 0 errors",
    },
    {
      id: "cmd-3",
      step: "test",
      command: "npm test",
      status: preset === "empty" ? "not run" : preset === "blocked" ? "No tests found" : "passed",
      ruleId: preset === "blocked" ? "M13" : undefined,
      exitCode: preset === "empty" || preset === "blocked" ? null : 0,
      durationMs: preset === "empty" || preset === "blocked" ? undefined : 920,
    },
  ];

  const pactStatus =
    preset === "resurrected"
      ? "approved"
      : preset === "failed"
      ? "error"
      : "ready";

  const skeletons: SkeletonData[] = [
    {
      skeletonId: "skel-bonesetter-01",
      role: "bonesetter",
      state: preset === "failed" ? "failed" : preset === "resurrected" ? "merged" : "running",
      taskIds: ["T1", "T2"],
      attempt: 1,
      currentToolCall:
        preset === "active" || preset === "loading"
          ? { tool: "apply_patch", startedAt: FIXED_NOW_MS - 12000 }
          : null,
      toolCallsCount: 14,
      logs: [
        "[kiro] Inspecting src/parser.ts:88 for Buffer deprecation",
        "[kiro] Applied Buffer.from() migration and updated tsconfig",
      ],
      elapsedSeconds: 84,
      credits: null,
      worktree: "wt/T2-buffer-fix",
      lastEvent: {
        seq: 18,
        kind: "skeleton.tool_call",
        ts: FIXED_NOW_MS,
        actor: "skel-bonesetter-01",
      },
    },
    {
      skeletonId: "skel-warden-01",
      role: "warden",
      state:
        preset === "blocked"
          ? "awaiting_approval"
          : preset === "resurrected"
          ? "completed"
          : "recovering",
      taskIds: ["warden_final_check"],
      attempt: 1,
      currentToolCall: null,
      toolCallsCount: 6,
      logs: [
        "[warden] Grimoire gate M1-M6 passed with zero violations",
        "[warden] Candidate SHA verified against worktree diff",
      ],
      elapsedSeconds: 42,
      credits: null,
      worktree: "wt/warden-audit",
      lastEvent: {
        seq: 24,
        kind: "gate.result",
        ts: FIXED_NOW_MS,
        actor: "warden",
      },
      silentSeconds: preset === "blocked" ? 145 : 0,
      isSilent: preset === "blocked",
    },
    {
      skeletonId: "skel-stitcher-02",
      role: "soul-stitcher",
      state: preset === "empty" ? "laid_to_rest" : "merged",
      taskIds: ["T3"],
      attempt: 2,
      currentToolCall: null,
      toolCallsCount: 9,
      logs: ["[stitcher] Added unit regression tests in test/parser.test.ts"],
      elapsedSeconds: 61,
      credits: null,
      worktree: "wt/T3-tests",
      lastEvent: null,
    },
  ];

  const reliquaryOutcome =
    preset === "loading"
      ? undefined
      : preset === "failed"
      ? "not_resurrected"
      : preset === "blocked"
      ? "partial"
      : preset === "empty"
      ? "cancelled"
      : "resurrected";

  const populatedBeforeAfter: ReliquaryBeforeAfterTableProps = {
    installBefore: { status: "failed", exitCode: 1, duration: 3200, command: "npm install --ignore-scripts" },
    installAfter:
      preset === "empty" || preset === "loading"
        ? undefined
        : { status: "passed", exitCode: 0, duration: 2450, command: "npm ci --ignore-scripts" },
    buildBefore: { status: "not run", exitCode: null, command: "npm run build" },
    buildAfter:
      preset === "empty" || preset === "loading"
        ? undefined
        : {
            status: preset === "failed" ? "failed" : "passed",
            exitCode: preset === "failed" ? 2 : 0,
            duration: 1850,
            command: "npm run build",
          },
    testsRepoBefore: { status: "failed", exitCode: 1, command: "npm test" },
    testsRepoAfter:
      preset === "resurrected"
        ? { status: "passed", exitCode: 0, duration: 920, command: "npm test" }
        : undefined,
    grimoireBefore: { status: "signals found", exitCode: 1 },
    grimoireAfter:
      preset === "resurrected" || preset === "active"
        ? { status: "clean", exitCode: 0 }
        : undefined,
    lockfileBefore: { status: "missing" },
    lockfileAfter:
      preset === "resurrected" ? { status: "present", exitCode: 0 } : undefined,
    runtimeBefore: { status: "legacy" },
    runtimeAfter:
      preset === "resurrected" ? { status: "modern", exitCode: 0 } : undefined,
    testsAddedBefore: { status: "none" },
    testsAddedAfter:
      preset === "resurrected" ? { status: "passed", exitCode: 0 } : undefined,
  };

  return {
    preset,
    healthBadges,
    statusPills,
    signalChips,
    commandRows,
    deathCertificate: cert,
    receiptChip: signalChips[1],
    pactBudget: {
      ceiling: { maxMinutes: 60, maxParallel: 2, maxCredits: null, maxToolCalls: 120 },
      budget: { maxMinutes: 45, maxParallel: 2, maxToolCalls: 80 },
      disabled: preset === "resurrected" || preset === "blocked",
      creditsReported: false,
    },
    pactDiff:
      preset === "empty"
        ? { previousVersion: 1, currentVersion: 1 }
        : {
            previousVersion: 1,
            currentVersion: 2,
            addedTaskIds: ["T3"],
            removedTaskIds: [],
            modifiedTaskIds: ["T2"],
            diffText:
              "@@ Task T2 @@\n- acceptance: npm run lint\n+ acceptance: npm run build && npm test\n+ added T3: Add regression unit tests",
          },
    pactEditorValid: {
      pactVersion: 2,
      tasks: validTasks,
      markdown: "# Necromancer Pact v2\n- T1: Restore lockfile\n- T2: Fix Buffer deprecation\n",
      phase: "pact_review",
      status: pactStatus,
      ceiling: { maxMinutes: 60, maxParallel: 2, maxCredits: null, maxToolCalls: 120 },
      deathCertificate: cert,
    },
    pactEditorWithCycle: {
      pactVersion: 2,
      tasks: cycleTasks,
      markdown: "# Necromancer Pact v2 (Cycle Demo)\n",
      phase: "pact_review",
      status: "ready",
      ceiling: { maxMinutes: 60, maxParallel: 2, maxCredits: null, maxToolCalls: 120 },
      deathCertificate: cert,
    },
    legionHeader: {
      runId: "debug-run-01",
      phase:
        preset === "resurrected"
          ? "done"
          : preset === "blocked"
          ? "pact_review"
          : preset === "loading"
          ? "queued"
          : "legion",
      latestToolCall:
        preset === "active"
          ? { tool: "apply_patch", skeletonId: "skel-bonesetter-01" }
          : null,
      pendingActionsCount: preset === "blocked" ? 1 : 0,
      pendingActionDescription:
        preset === "blocked" ? "Approve Warden merge candidate" : null,
      elapsedSeconds: preset === "loading" ? 0 : 142,
      toolCallsUsed: preset === "loading" ? 0 : 29,
      toolCallsCap: preset === "loading" || preset === "empty" ? null : 80,
      wallClockMinutes: preset === "loading" ? 0 : 3,
      wallClockCapMinutes: preset === "loading" || preset === "empty" ? null : 45,
      creditsUsed: null,
      creditsCap: null,
    },
    skeletons,
    waitingRoom: {
      position: preset === "blocked" ? 2 : 1,
      ahead: preset === "blocked" ? 1 : 0,
      runId: "debug-run-01",
      cancelling: false,
      cancelError: preset === "failed" ? "Queue cancellation timed out" : null,
    },
    approval: {
      approvalId: "appr-debug-01",
      command: "npm test -- --runInBand",
      cwd: "/workspace/repo",
      riskClass: "needs_approval",
      reason: "Warden requests verification test execution before merge seal.",
      skeletonId: "skel-warden-01",
      expiresAt: FIXED_NOW_MS + 600_000,
      status: preset === "resurrected" ? "resolved" : "pending",
      resolution: preset === "resurrected" ? "approve_once" : undefined,
    },
    ask: {
      askId: "ask-debug-01",
      question:
        "The build script invokes a removed gulp task. Keep the script and patch the task, or drop the script?",
      options: ["Patch the task", "Drop the script"],
      skeletonId: "skel-bonesetter-01",
      taskId: "T2",
      status: preset === "resurrected" ? "answered" : "open",
      answer: preset === "resurrected" ? "Patch the task" : undefined,
    },
    reliquaryView: {
      runId: "debug-relic",
      outcome: reliquaryOutcome,
      owner: "acme-crypt",
      repo: "legacy-ledger",
      baseSha: "9f3c1b2",
      headSha: "4e81d0c",
      packing: preset === "loading",
      push: {
        enabled: preset === "resurrected",
        targetFork: "owner/legacy-ledger",
        branch: "graveyard/debug-relic",
      },
      reportCheck: {
        passed: preset === "resurrected",
        failed: preset === "failed",
        reading: preset === "resurrected" ? "All claims verified against command receipts" : null,
      },
      diff:
        preset === "empty"
          ? null
          : "--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -86,2 +86,2 @@\n-  return new Buffer(raw);\n+  return Buffer.from(raw);\n",
      tasks:
        preset === "empty"
          ? []
          : [
              {
                id: "T1",
                title: "Restore lockfile and pin Node runtime",
                state: "merged",
                attempts: 1,
                verdict: "approve",
                reasons: ["npm ci exited 0"],
              },
              {
                id: "T2",
                title: "Replace deprecated Buffer constructor",
                state: preset === "failed" ? "failed" : "merged",
                attempts: 1,
                verdict: preset === "failed" ? "reject" : "approve",
                reasons:
                  preset === "failed"
                    ? ["Build failed at src/parser.ts:88"]
                    : ["Build and tests passed"],
              },
            ],
      artifacts:
        preset === "empty" || preset === "loading" ? [] : REALISTIC_ARTIFACTS,
      initialEvents:
        preset === "loading"
          ? [
              {
                runId: "debug-relic",
                seq: 1,
                ts: FIXED_NOW_MS,
                kind: "run.phase",
                actor: "system",
                data: { phase: "report", refs: [] },
              },
            ]
          : [],
    },
    beforeAfterTable:
      preset === "empty" || preset === "loading" ? {} : populatedBeforeAfter,
    artifactDownloads: {
      runId: "debug-relic",
      packing: preset === "loading",
      artifacts:
        preset === "empty" || preset === "loading" ? [] : REALISTIC_ARTIFACTS,
      noTasksMerged: preset === "failed",
    },
  };
}
