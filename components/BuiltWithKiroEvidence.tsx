"use client";

import React from "react";
import { CryptOrnament } from "@/components/ui/CryptOrnament";
import { StatusPill } from "@/components/ui/StatusPill";
import type {
  EvidenceAgent,
  EvidenceBundle,
  EvidenceHook,
  EvidenceSteering,
  KiroEvidenceDoc,
  PublishedRunEvidence,
} from "@/lib/evidence/evidence-service";

export interface BuiltWithKiroEvidenceProps {
  bundle?: EvidenceBundle;
  build?: KiroEvidenceDoc;
  recentRuns?: PublishedRunEvidence[];
}

const NONE_FOUND = "None found";

function SectionHeading({ index, title }: { index: string; title: string }): React.ReactElement {
  return (
    <h3 className="text-xs font-semibold text-bone uppercase tracking-[0.16em]">
      {index} · {title}
    </h3>
  );
}

function EmptyLine({ label }: { label: string }): React.ReactElement {
  return (
    <p className="text-xs text-dust font-mono" data-testid={`evidence-empty-${label}`}>
      {NONE_FOUND}
    </p>
  );
}

function SpecsSection({ build }: { build: KiroEvidenceDoc }): React.ReactElement {
  const seen = new Set<string>();
  const specs = build.specs.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
  return (
    <section className="space-y-3" data-testid="evidence-specs">
      <SectionHeading index="01" title="Specs (.kiro/specs)" />
      {specs.length === 0 ? (
        <EmptyLine label="specs" />
      ) : (
        <ul className="list-disc list-inside space-y-1 text-xs font-mono text-parchment">
          {specs.map((s) => (
            <li key={s.path} data-testid="evidence-spec-item">
              <span className="text-emerald-300">{s.name}</span>{" "}
              <span className="text-dust">— {s.path}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SteeringSection({ build }: { build: KiroEvidenceDoc }): React.ReactElement {
  return (
    <section className="space-y-3" data-testid="evidence-steering">
      <SectionHeading index="02" title="Steering files (.kiro/steering)" />
      {build.steering.length === 0 ? (
        <EmptyLine label="steering" />
      ) : (
        <ul className="space-y-1.5 text-xs font-mono text-parchment">
          {build.steering.map((s: EvidenceSteering) => (
            <li
              key={s.path}
              className="flex flex-wrap items-center gap-2"
              data-testid="evidence-steering-item"
            >
              <span className="text-emerald-300">{s.name}</span>
              <span className="crypt-well px-1.5 py-0.5 text-[10px] text-amber-200">
                inclusion: {s.inclusion}
              </span>
              <span className="text-dust">{s.path}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HooksSection({ build }: { build: KiroEvidenceDoc }): React.ReactElement {
  return (
    <section className="space-y-3" data-testid="evidence-hooks">
      <SectionHeading index="03" title="Build hooks (.kiro/hooks)" />
      {build.hooks.length === 0 ? (
        <EmptyLine label="hooks" />
      ) : (
        <ul className="space-y-1.5 text-xs font-mono text-parchment">
          {build.hooks.map((h: EvidenceHook, i) => (
            <li key={`${h.name}-${i}`} data-testid="evidence-hook-item">
              <span className="text-emerald-300">{h.name}</span>{" "}
              <span className="crypt-well px-1.5 py-0.5 text-[10px] text-violet-200">
                {h.trigger}
              </span>
              {h.matcher && <span className="text-dust">match {h.matcher}</span>}
              {h.command && <div className="text-dust pl-4">→ {h.command}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentsSection({ build }: { build: KiroEvidenceDoc }): React.ReactElement {
  return (
    <section className="space-y-3" data-testid="evidence-agents">
      <SectionHeading index="04" title="Role agent templates (lib/agents/templates)" />
      {build.agents.length === 0 ? (
        <EmptyLine label="agents" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {build.agents.map((a: EvidenceAgent) => (
            <div
              key={a.path}
              className="crypt-well p-3.5 space-y-2"
              data-testid="evidence-agent-item"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-emerald-300">{a.name}</span>
                {a.modelTier && <span className="text-[10px] text-amber-200">{a.modelTier}</span>}
              </div>
              {a.description && (
                <p className="text-[11px] text-ash leading-snug">{a.description}</p>
              )}
              <div className="text-[11px] font-mono space-y-1">
                <div>
                  <span className="text-dust">tools: </span>
                  <span className="text-parchment">
                    {a.tools.length > 0 ? a.tools.join(", ") : NONE_FOUND}
                  </span>
                </div>
                <div>
                  <span className="text-dust">excluded: </span>
                  <span className="text-parchment">
                    {a.excludedTools.length > 0 ? a.excludedTools.join(", ") : NONE_FOUND}
                  </span>
                </div>
                <div>
                  <span className="text-dust">permissions: </span>
                  <span className="text-parchment">
                    {a.permissions.length > 0
                      ? a.permissions.map((p) => `${p.capability}:${p.effect}`).join(", ")
                      : NONE_FOUND}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RuntimeRunsSection({ runs }: { runs: PublishedRunEvidence[] }): React.ReactElement {
  return (
    <section className="space-y-3" data-testid="evidence-runtime-runs">
      <SectionHeading index="05" title="Recent published runs (runtime Skeleton records)" />
      {runs.length === 0 ? (
        <EmptyLine label="runtime-runs" />
      ) : (
        <div className="space-y-4">
          {runs.map((run) => (
            <div
              key={run.runId || run.date}
              className="crypt-well p-3.5 space-y-2"
              data-testid="evidence-run-item"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-bone">
                  {run.repository || run.runId || "unknown run"}
                </span>
                {run.outcome && (
                  <StatusPill
                    tone={run.outcome === "resurrected" ? "emerald" : "neutral"}
                    label={run.outcome}
                    className="text-[10px] px-2 py-0.5"
                  />
                )}
              </div>
              {run.skeletons.length === 0 ? (
                <EmptyLine label={`skeletons-${run.runId || "run"}`} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px] font-mono text-parchment">
                    <thead>
                      <tr className="text-left text-dust">
                        <th className="pr-3 py-1 font-semibold">Role</th>
                        <th className="pr-3 py-1 font-semibold">Agent</th>
                        <th className="pr-3 py-1 font-semibold">Model</th>
                        <th className="pr-3 py-1 font-semibold">Kiro CLI</th>
                        <th className="pr-3 py-1 font-semibold">Session</th>
                        <th className="py-1 font-semibold">Timestamp</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.skeletons.map((sk, i) => (
                        <tr key={`${sk.sessionId || sk.role}-${i}`} data-testid="evidence-skeleton-row">
                          <td className="pr-3 py-1 text-emerald-300">{sk.role || NONE_FOUND}</td>
                          <td className="pr-3 py-1">{sk.agentName || NONE_FOUND}</td>
                          <td className="pr-3 py-1">{sk.modelId || NONE_FOUND}</td>
                          <td className="pr-3 py-1">{sk.kiroCliVersion || NONE_FOUND}</td>
                          <td className="pr-3 py-1">{sk.sessionId || NONE_FOUND}</td>
                          <td className="py-1 text-dust">
                            {sk.timestamp > 0 ? new Date(sk.timestamp).toISOString() : NONE_FOUND}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function NotKiroSection(): React.ReactElement {
  return (
    <section
      className="space-y-3 border-l-2 border-l-amber-400/70 pl-4"
      data-testid="evidence-not-kiro"
    >
      <SectionHeading index="06" title="What does not use Kiro" />
      <div className="text-xs font-mono text-parchment space-y-2">
        <p>
          The Grimoire autopsy path runs no model. It is a deterministic, rule-based
          engine (rules M1–M6 over <code className="crypt-well px-1.5 py-0.5">@babel/parser</code>{" "}
          and <code className="crypt-well px-1.5 py-0.5">web-tree-sitter</code>) that diagnoses
          why a repository died and doubles as the pre-merge gate.
        </p>
        <ul className="list-disc list-inside space-y-1 text-ash">
          <li>No Kiro CLI session and no model call during the autopsy.</li>
          <li>No repository code is executed during the autopsy.</li>
          <li>
            Rules and gates that do not call models: the Grimoire syntax gate, the
            deterministic Scheduler dependency evaluation, and the Warden merge gate
            checks (candidateSha256 match, no test weakening).
          </li>
        </ul>
      </div>
    </section>
  );
}

export function BuiltWithKiroEvidence({
  bundle,
  build: buildProp,
  recentRuns: runsProp,
}: BuiltWithKiroEvidenceProps): React.ReactElement {
  const build: KiroEvidenceDoc =
    bundle?.build ??
    buildProp ?? {
      schemaVersion: "v1",
      generatedFromSha: "",
      specs: [],
      steering: [],
      hooks: [],
      agents: [],
      commitLinks: [],
    };
  const runs: PublishedRunEvidence[] = bundle?.recentRuns ?? runsProp ?? [];

  return (
    <div
      className="space-y-8 font-mono"
      data-testid="built-with-kiro-evidence"
      data-ui-element="built-with-kiro-evidence"
    >
      <section className="space-y-2">
        <div className="text-[11px] text-emerald-400/90 uppercase tracking-[0.18em]">
          Stage V · Built with Kiro
        </div>
        <h2 className="text-xl md:text-2xl font-bold text-bone tracking-tight">
          How Kiro built and ran Git-Graveyard
        </h2>
        <p className="text-xs text-ash">
          Every item below is generated from real files and run records
          {build.generatedFromSha ? ` at commit ${build.generatedFromSha}` : ""}.
        </p>
      </section>

      <SpecsSection build={build} />
      <CryptOrnament kind="divider" />
      <SteeringSection build={build} />
      <CryptOrnament kind="divider" />
      <HooksSection build={build} />
      <CryptOrnament kind="divider" />
      <AgentsSection build={build} />
      <CryptOrnament kind="divider" />
      <RuntimeRunsSection runs={runs} />
      <CryptOrnament kind="divider" />
      <NotKiroSection />
    </div>
  );
}

export default BuiltWithKiroEvidence;