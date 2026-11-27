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
  certificate?: KiroHandoffCertificate | null;
  verificationCommands?: readonly string[];
}

export interface KiroHandoffCommandStep {
  step?: string;
  command?: string | readonly string[];
  status?: string;
  noTestsFound?: boolean;
}

export interface KiroHandoffCertificate {
  primaryLanguage?: string;
  packageManager?: string;
  install?: KiroHandoffCommandStep;
  retry?: KiroHandoffCommandStep;
  build?: KiroHandoffCommandStep;
  test?: KiroHandoffCommandStep;
  rows?: readonly KiroHandoffCommandStep[];
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
 * Collapse a recorded command (a single line or an argv array) into one clean
 * line. Returns null for empty values and for the sentinel "not recorded" /
 * "not run" markers so callers never emit a placeholder as a real command.
 */
function normalizeCommand(cmd?: string | readonly string[]): string | null {
  if (cmd === undefined || cmd === null) return null;
  let joined: string;
  if (typeof cmd === "string") {
    joined = cmd;
  } else {
    joined = (cmd as readonly string[])
      .map((part) => String(part).trim())
      .filter((part) => part.length > 0)
      .join(" ");
  }
  const collapsed = joined.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  const lower = collapsed.toLowerCase();
  if (lower === "not recorded" || lower === "not run") return null;
  return collapsed;
}

/** A step is runnable only when it has a real command and was not skipped. */
function isRunnableStep(step?: KiroHandoffCommandStep): boolean {
  if (!step) return false;
  if (step.noTestsFound === true) return false;
  const status = (step.status ?? "").trim().toLowerCase();
  if (status === "not run" || status === "no tests found") return false;
  return normalizeCommand(step.command) !== null;
}

/** Remove duplicate commands while preserving first-seen order. */
function dedupeCommands(commands: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cmd of commands) {
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    out.push(cmd);
  }
  return out;
}

/**
 * Derive the verification commands to run after applying a patch. Commands come
 * only from what was actually recorded (explicit verificationCommands or the
 * Death Certificate); steps that were not run, found no tests, or were never
 * recorded are omitted rather than guessed. When nothing is recorded, no
 * commands are assumed.
 */
export function deriveVerificationCommands(input: KiroHandoffInput): string[] {
  // Explicit verification commands take precedence when supplied.
  if (input.verificationCommands !== undefined) {
    const normalized: string[] = [];
    for (const raw of input.verificationCommands) {
      const cmd = normalizeCommand(raw);
      if (cmd !== null) normalized.push(cmd);
    }
    return dedupeCommands(normalized);
  }

  const cert = input.certificate;
  if (cert) {
    const rows = Array.isArray(cert.rows) ? cert.rows : [];
    const lastByStep = (name: string): KiroHandoffCommandStep | undefined => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]?.step === name) return rows[i];
      }
      return undefined;
    };

    const installRow = cert.install ?? lastByStep("install");
    const retryRow = cert.retry ?? lastByStep("retry");
    const buildRow = cert.build ?? lastByStep("build");
    const testRow = cert.test ?? lastByStep("test");

    const commands: string[] = [];

    // Install: prefer the retry when the first install failed and the retry ran.
    const installFailed = (installRow?.status ?? "").toLowerCase() === "failed";
    if (installFailed && isRunnableStep(retryRow)) {
      const cmd = normalizeCommand(retryRow?.command);
      if (cmd) commands.push(cmd);
    } else if (isRunnableStep(installRow)) {
      const cmd = normalizeCommand(installRow?.command);
      if (cmd) commands.push(cmd);
    } else if (isRunnableStep(retryRow)) {
      const cmd = normalizeCommand(retryRow?.command);
      if (cmd) commands.push(cmd);
    }

    if (isRunnableStep(buildRow)) {
      const cmd = normalizeCommand(buildRow?.command);
      if (cmd) commands.push(cmd);
    }

    if (isRunnableStep(testRow)) {
      const cmd = normalizeCommand(testRow?.command);
      if (cmd) commands.push(cmd);
    }

    const concrete = dedupeCommands(commands);
    if (concrete.length > 0) return concrete;

    // No runnable rows were recorded. When every present step was explicitly
    // marked not run / no tests found, treat them as inapplicable and emit
    // nothing. Otherwise fall back to minimal, language-appropriate defaults.
    const present = [installRow, buildRow, testRow].filter(
      (r): r is KiroHandoffCommandStep => r !== undefined
    );
    const allExplicitlyInapplicable =
      present.length > 0 &&
      present.every((r) => {
        const s = (r.status ?? "").trim().toLowerCase();
        return s === "not run" || s === "no tests found";
      });
    if (allExplicitlyInapplicable) return [];

    const lang = (cert.primaryLanguage ?? "").trim().toLowerCase();
    const pm = (cert.packageManager ?? "").trim().toLowerCase();

    if (lang === "python") {
      if (pm === "poetry") return ["poetry install", "pytest"];
      return ["pip install -r requirements.txt", "pytest"];
    }
    if (lang === "node" || lang === "javascript" || lang === "typescript") {
      const pmInstall =
        pm === "yarn" ? "yarn install" : pm === "pnpm" ? "pnpm install" : "npm install";
      const pmTest = pm === "yarn" ? "yarn test" : pm === "pnpm" ? "pnpm test" : "npm test";
      return [pmInstall, pmTest];
    }
    return [];
  }

  // Neither source supplied: never assume unrecorded commands.
  return [];
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
  const verificationCommands = deriveVerificationCommands(input);

  const cloneDir = `git-graveyard-${runId}`;
  // Primary target nests under resurrection/<owner>-<repo>; fallback is flat.
  const specCopyTarget = `.kiro/specs/resurrection/${owner}-${repo}/`;
  const specCopyFallback = `.kiro/specs/${owner}-${repo}/`;

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  const steps: KiroHandoffStep[] = [
    {
      title: "Clone at the pinned base sha and apply the patch",
      detail:
        `Clone ${owner}/${repo} and check out the pinned base commit ${baseSha}. ` +
        "Then copy the downloaded all.patch file from your Reliquary Downloads " +
        '(for example "$HOME/Downloads/all.patch") into the clone directory before ' +
        "applying it. The patch is applied with -p1 to match the repository root layout.",
      commands: [
        `git clone ${cloneUrl} ${cloneDir}`,
        `cd ${cloneDir}`,
        `git checkout ${baseSha}`,
        `cp "$HOME/Downloads/all.patch" .`,
        "git apply -p1 all.patch",
      ],
    },
    {
      title: "Copy the spec bundle into Kiro's spec folder",
      detail:
        "Place the downloaded spec/ bundle directory alongside the clone (or copy it " +
        "from the downloaded spec export) so the copy source is available, then copy " +
        "the generated spec/ directory into the Kiro specs folder so the spec appears " +
        "in the Kiro IDE / CLI.",
      commands: [
        `mkdir -p ${specCopyTarget}`,
        `cp -R spec/. ${specCopyTarget}`,
      ],
    },
    {
      title: "Resume development locally with the Kiro CLI",
      detail:
        verificationCommands.length > 0
          ? "Run the spec to resume the resurrection workflow, then run the recorded verification commands from the certificate."
          : "Run the spec to resume the resurrection workflow, then run the verification commands recorded in the Death Certificate (inapplicable build/test steps are omitted).",
      commands: [
        `kiro-cli`,
        `/spec run ${specRunName}`,
        ...verificationCommands,
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