/**
 * Open in Kiro handoff instructions (Task 26.4 / Requirements 38.9, 48.11, 48.12).
 *
 * Builds safe, copy-friendly clone & apply instructions from a run bundle so a
 * user can resume development locally in Kiro. All inputs are validated/sanitized
 * so the generated commands cannot break out of the intended repository layout.
 */

export interface KiroHandoffInput {
  owner: string;
  repo: string;
  baseSha: string;
  runId: string;
  targetSpecName?: string;
}

export interface KiroHandoffStep {
  title: string;
  detail: string;
  commands: string[];
}

export interface KiroHandoffPlan {
  owner: string;
  repo: string;
  baseSha: string;
  runId: string;
  cloneDir: string;
  specCopyTarget: string;
  specCopyFallback: string;
  specRunName: string;
  steps: KiroHandoffStep[];
}

/** Allow only safe characters for owner/repo/spec identifiers. */
function sanitizeIdent(raw: string, fallback: string): string {
  const cleaned = (raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Validate/normalize a git sha; fall back to a placeholder if malformed. */
function sanitizeSha(raw: string): string {
  const cleaned = (raw ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{7,40}$/.test(cleaned)) return cleaned;
  return "BASE_SHA";
}

/**
 * Build a safe handoff plan. Throws only if owner/repo/runId are entirely empty
 * after sanitization AND no fallback can be applied (never in practice).
 */
export function buildKiroHandoff(input: KiroHandoffInput): KiroHandoffPlan {
  const owner = sanitizeIdent(input.owner, "owner");
  const repo = sanitizeIdent(input.repo, "repo");
  const runId = sanitizeIdent(input.runId, "run");
  const baseSha = sanitizeSha(input.baseSha);
  const specRunName = sanitizeIdent(input.targetSpecName ?? "resurrection", "resurrection");

  const cloneDir = `git-graveyard-${runId}`;
  // Primary target nests under resurrection/<owner>-<repo>; fallback is flat.
  const specCopyTarget = `.kiro/specs/resurrection/${owner}-${repo}/`;
  const specCopyFallback = `.kiro/specs/${owner}-${repo}/`;

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  const steps: KiroHandoffStep[] = [
    {
      title: "Clone at the pinned base sha and apply the patch",
      detail:
        `Clone ${owner}/${repo}, check out the pinned base commit, then apply the run patch. ` +
        "The patch is applied with -p1 to match the repository root layout. " +
        "The upstream repository does not contain the downloaded run bundle, so first " +
        "extract the downloaded archive into BUNDLE_DIR and copy all.patch and spec/ " +
        "into the clone directory before running git apply -p1 all.patch.",
      commands: [
        `git clone ${cloneUrl} ${cloneDir}`,
        `cd ${cloneDir}`,
        `git checkout ${baseSha}`,
        `export BUNDLE_DIR="$HOME/Downloads/git-graveyard-${runId}"`,
        `mkdir -p "$BUNDLE_DIR"`,
        `tar -xzf "$HOME/Downloads/git-graveyard-${runId}.tar.gz" -C "$BUNDLE_DIR"`,
        `cp -R "$BUNDLE_DIR/all.patch" "$BUNDLE_DIR/spec" .`,
        "git apply -p1 all.patch",
      ],
    },
    {
      title: "Copy the spec bundle into Kiro's spec folder",
      detail:
        "Copy the generated spec/ directory into the Kiro specs folder so the spec " +
        "appears in the Kiro IDE / CLI.",
      commands: [
        `mkdir -p ${specCopyTarget}`,
        `cp -R spec/. ${specCopyTarget}`,
      ],
    },
    {
      title: "Resume development locally with the Kiro CLI",
      detail:
        "Run the spec to resume the resurrection workflow, then verify the build and tests.",
      commands: [
        `kiro-cli`,
        `/spec run ${specRunName}`,
        "npm install",
        "npm run build",
        "npm test",
      ],
    },
  ];

  return {
    owner,
    repo,
    baseSha,
    runId,
    cloneDir,
    specCopyTarget,
    specCopyFallback,
    specRunName,
    steps,
  };
}

/** Render the handoff plan as a plain-text block (copy-friendly). */
export function formatKiroHandoffText(plan: KiroHandoffPlan): string {
  const lines: string[] = [];
  lines.push(`Open in Kiro — ${plan.owner}/${plan.repo} (run ${plan.runId})`);
  lines.push("");
  plan.steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.title}`);
    lines.push(`   ${step.detail}`);
    for (const cmd of step.commands) {
      lines.push(`   $ ${cmd}`);
    }
    lines.push("");
  });
  lines.push(
    `Note (fallback): if Kiro does not list nested spec folders, copy spec/ to ${plan.specCopyFallback} instead.`
  );
  return lines.join("\n");
}