/**
 * Model ID override: accounts that cannot use the pinned Claude 5.5 models can set
 * GG_MODEL_OPUS / GG_MODEL_SONNET / GG_MODEL_HAIKU. Defaults must stay unchanged.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveModelId } from "../../lib/agents/model-allowlist";

const PROJECT_ROOT = path.resolve(__dirname, "../..");

function runInChildProcess(script: string, env: Record<string, string>): string {
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  delete cleanEnv.GG_MODEL_OPUS;
  delete cleanEnv.GG_MODEL_SONNET;
  delete cleanEnv.GG_MODEL_HAIKU;
  return execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: PROJECT_ROOT,
    env: { ...cleanEnv, ...env },
    encoding: "utf-8",
  }).trim();
}

describe("resolveModelId", () => {
  it("returns the fallback when the override is unset", () => {
    assert.equal(resolveModelId(undefined, "claude-opus-5.5"), "claude-opus-5.5");
  });

  it("returns the fallback when the override is blank", () => {
    assert.equal(resolveModelId("   ", "claude-opus-5.5"), "claude-opus-5.5");
  });

  it("rejects auto in any casing and falls back", () => {
    assert.equal(resolveModelId("auto", "claude-opus-5.5"), "claude-opus-5.5");
    assert.equal(resolveModelId(" AUTO ", "claude-opus-5.5"), "claude-opus-5.5");
  });

  it("returns the trimmed override when it is a real model id", () => {
    assert.equal(resolveModelId(" claude-sonnet-4.5 ", "claude-opus-5.5"), "claude-sonnet-4.5");
  });
});

describe("model constants under override", () => {
  it("keeps the Claude 5.5 defaults when no override is set", () => {
    const out = runInChildProcess(
      `const m=require("./lib/agents/model-allowlist");console.log(JSON.stringify(m.ROLE_DEFAULT_MODELS))`,
      {}
    );
    const roles = JSON.parse(out);
    assert.equal(roles.planner, "claude-opus-5.5");
    assert.equal(roles.bonesetter, "claude-sonnet-5.5");
    assert.equal(roles.scribe, "claude-haiku-5.5");
  });

  it("applies the overrides to role defaults, the allowlist and verification", () => {
    const out = runInChildProcess(
      `const m=require("./lib/agents/model-allowlist");
       const v=m.verifySessionModel({model:"claude-sonnet-4.5"},"planner");
       console.log(JSON.stringify({roles:m.ROLE_DEFAULT_MODELS,allowed:m.isAllowedModelId("claude-sonnet-4.5"),oldAllowed:m.isAllowedModelId("claude-opus-5.5"),ok:v.ok}))`,
      {
        GG_MODEL_OPUS: "claude-sonnet-4.5",
        GG_MODEL_SONNET: "claude-sonnet-4.5",
        GG_MODEL_HAIKU: "claude-haiku-4.5",
      }
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.roles.planner, "claude-sonnet-4.5");
    assert.equal(parsed.roles.warden, "claude-sonnet-4.5");
    assert.equal(parsed.roles.scribe, "claude-haiku-4.5");
    assert.equal(parsed.allowed, true);
    assert.equal(parsed.oldAllowed, false);
    assert.equal(parsed.ok, true);
  });

  it("writes the overridden model into the generated Kiro agent file", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-model-override-"));
    try {
      const templates = path.join(base, "templates");
      fs.mkdirSync(templates, { recursive: true });
      fs.writeFileSync(
        path.join(templates, "planner.md"),
        "---\ndescription: test planner\nmodelTier: Claude Opus 5.5\n---\nbody\n",
        "utf-8"
      );
      const script = `
        const fs=require("fs");const path=require("path");
        const env=require("./lib/supervisor/skeleton-env");
        const paths=env.resolveSkeletonPaths("run1","sk1",path.join(${JSON.stringify(base)},"runs"));
        env.provisionSkeletonEnvironment({paths,role:"planner",templatesDir:${JSON.stringify(templates)}});
        const file=fs.readdirSync(paths.homeAgentsDir).find(f=>f.endsWith(".json"));
        console.log(JSON.parse(fs.readFileSync(path.join(paths.homeAgentsDir,file),"utf-8")).model);
      `;

      const model = runInChildProcess(script, { GG_MODEL_OPUS: "claude-sonnet-4.5" });

      assert.equal(model, "claude-sonnet-4.5");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
