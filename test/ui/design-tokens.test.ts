import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const GLOBALS_CSS_PATH = path.join(ROOT, "app", "globals.css");
const MOTION_CSS_PATH = path.join(ROOT, "styles", "motion.css");

function extractRootBlock(css: string): string {
  const match = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, "Expected :root { ... } block in app/globals.css");
  return match[1];
}

function parseCssCustomProperties(block: string): Map<string, string> {
  const cleaned = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const vars = new Map<string, string>();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    vars.set(m[1], m[2].trim());
  }
  return vars;
}

function resolveCssValue(
  name: string,
  vars: Map<string, string>,
  seen = new Set<string>()
): string {
  assert.ok(!seen.has(name), `Circular CSS variable reference at ${name}`);
  const raw = vars.get(name);
  assert.ok(raw !== undefined, `Missing CSS custom property ${name}`);
  const varMatch = raw.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/i);
  if (!varMatch) return raw;
  const target = varMatch[1];
  if (vars.has(target)) {
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    return resolveCssValue(target, vars, nextSeen);
  }
  assert.ok(varMatch[2], `Unresolvable CSS var ${raw}`);
  return varMatch[2].trim();
}

function parseHexColor(hex: string): [number, number, number] {
  const m = hex.trim().match(/^#([0-9a-f]{6})$/i);
  assert.ok(m, `Expected 6-digit hex color, got: ${hex}`);
  const num = parseInt(m[1], 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function wcagContrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(parseHexColor(fgHex));
  const l2 = relativeLuminance(parseHexColor(bgHex));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function extractKeyframesBlocks(
  css: string
): Array<{ name: string; body: string }> {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const results: Array<{ name: string; body: string }> = [];
  const headerRe = /@keyframes\s+([a-z0-9_-]+)\s*\{/gi;
  let match: RegExpExecArray | null;

  while ((match = headerRe.exec(cleaned)) !== null) {
    const name = match[1];
    let depth = 1;
    let idx = headerRe.lastIndex;
    const start = idx;
    while (idx < cleaned.length && depth > 0) {
      if (cleaned[idx] === "{") depth += 1;
      else if (cleaned[idx] === "}") depth -= 1;
      idx += 1;
    }
    results.push({ name, body: cleaned.slice(start, idx - 1) });
    headerRe.lastIndex = idx;
  }

  return results;
}

describe("Design tokens and WCAG contrast (app/globals.css)", () => {
  const globalsCss = fs.readFileSync(GLOBALS_CSS_PATH, "utf8");
  const rootVars = parseCssCustomProperties(extractRootBlock(globalsCss));

  const textTokens = [
    "--fg-bone",
    "--fg-parchment",
    "--fg-ash",
    "--fg-dust",
    "--state-risen-fg",
    "--state-wait-fg",
    "--state-fail-fg",
    "--state-idle-fg",
  ] as const;

  const surfaceTokens = [
    "--bg-abyss",
    "--bg-crypt",
    "--bg-slab",
    "--bg-slab-hover",
    "--bg-recessed",
    "--bg-sheet",
  ] as const;

  it("defines every required text and surface token and passes >= 4.5:1 WCAG 2.x contrast for all pairs", () => {
    for (const fgToken of textTokens) {
      const fgHex = resolveCssValue(fgToken, rootVars);
      for (const bgToken of surfaceTokens) {
        const bgHex = resolveCssValue(bgToken, rootVars);
        const ratio = wcagContrastRatio(fgHex, bgHex);
        assert.ok(
          ratio >= 4.5,
          `Contrast for ${fgToken} (${fgHex}) on ${bgToken} (${bgHex}) is ${ratio.toFixed(2)}:1 (< 4.5:1)`
        );
      }
    }
  });

  it("includes required theme mappings, candle tokens, shadows, glows, and motion timing tokens", () => {
    for (const token of [
      "--candle-flame",
      "--candle-core",
      "--candle-wax",
      "--shadow-slab",
      "--shadow-sheet",
      "--glow-emerald",
      "--glow-amber",
      "--glow-crimson",
      "--glow-candle",
      "--dur-quick",
      "--dur-base",
      "--dur-slow",
      "--dur-ritual",
      "--ease-out",
      "--ease-in",
      "--ease-standard",
      "--ease-stamp",
    ]) {
      assert.ok(rootVars.has(token), `Expected ${token} in :root`);
    }

    const themeMatch = globalsCss.match(/@theme\s+inline\s*\{([\s\S]*?)\n\}/);
    assert.ok(themeMatch, "Expected @theme inline block in app/globals.css");
    const themeVars = parseCssCustomProperties(themeMatch[1]);
    for (const themeToken of [
      "--color-sheet",
      "--color-state-risen",
      "--color-state-wait",
      "--color-state-fail",
      "--font-body",
      "--font-ritual",
      "--font-mono",
    ]) {
      assert.ok(
        themeVars.has(themeToken),
        `Expected ${themeToken} in @theme inline`
      );
    }
  });
});

describe("Motion stylesheet (styles/motion.css)", () => {
  const motionCss = fs.readFileSync(MOTION_CSS_PATH, "utf8");

  it("guards animations under both prefers-reduced-motion: reduce and html[data-ui-reduced-motion=\"true\"]", () => {
    assert.match(motionCss, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
    assert.match(motionCss, /html\[data-ui-reduced-motion="true"\]/);
  });

  it("only animates transform, opacity, or filter inside every @keyframes rule", () => {
    const allowedProps = new Set(["transform", "opacity", "filter"]);
    const keyframes = extractKeyframesBlocks(motionCss);
    assert.ok(keyframes.length > 0, "Expected named @keyframes in styles/motion.css");

    for (const kf of keyframes) {
      const stopBlocks = kf.body.match(/\{([^}]*)\}/g) ?? [];
      assert.ok(
        stopBlocks.length > 0,
        `Keyframe ${kf.name} should contain keyframe stop blocks`
      );
      for (const block of stopBlocks) {
        const inner = block.slice(1, -1);
        for (const decl of inner.split(";")) {
          const trimmed = decl.trim();
          if (!trimmed) continue;
          const colonIdx = trimmed.indexOf(":");
          assert.ok(colonIdx > 0, `Invalid declaration in ${kf.name}: ${trimmed}`);
          const prop = trimmed.slice(0, colonIdx).trim().toLowerCase();
          assert.ok(
            allowedProps.has(prop),
            `Keyframe ${kf.name} animates disallowed property "${prop}"`
          );
        }
      }
    }
  });
});
