/**
 * kiro-cli login reuse: the host auth store must be exposed inside the isolated
 * Skeleton HOME on both Linux (~/.local/share/kiro-cli) and macOS
 * (~/Library/Application Support/kiro-cli).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { linkHostKiroAuthStore } from "../../lib/supervisor/skeleton-env";

const LINUX_STORE = [".local", "share", "kiro-cli"];
const MACOS_STORE = ["Library", "Application Support", "kiro-cli"];

function makeHomes(): { hostHome: string; isolatedHome: string; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gg-auth-link-"));
  const hostHome = path.join(base, "host");
  const isolatedHome = path.join(base, "isolated");
  fs.mkdirSync(hostHome, { recursive: true });
  fs.mkdirSync(isolatedHome, { recursive: true });
  return { hostHome, isolatedHome, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function makeStore(home: string, segments: string[]): string {
  const dir = path.join(home, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.sqlite3"), "token-placeholder", "utf-8");
  return dir;
}

describe("linkHostKiroAuthStore", () => {
  it("links the macOS auth store into the isolated HOME", () => {
    const { hostHome, isolatedHome, cleanup } = makeHomes();
    try {
      const hostStore = makeStore(hostHome, MACOS_STORE);

      linkHostKiroAuthStore(hostHome, isolatedHome);

      const link = path.join(isolatedHome, ...MACOS_STORE);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), "macOS store is a symlink, not a copy");
      assert.equal(fs.realpathSync(link), fs.realpathSync(hostStore));
    } finally {
      cleanup();
    }
  });

  it("still links the Linux auth store into the isolated HOME", () => {
    const { hostHome, isolatedHome, cleanup } = makeHomes();
    try {
      const hostStore = makeStore(hostHome, LINUX_STORE);

      linkHostKiroAuthStore(hostHome, isolatedHome);

      const link = path.join(isolatedHome, ...LINUX_STORE);
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      assert.equal(fs.realpathSync(link), fs.realpathSync(hostStore));
    } finally {
      cleanup();
    }
  });

  it("creates no links when the host has no auth store", () => {
    const { hostHome, isolatedHome, cleanup } = makeHomes();
    try {
      linkHostKiroAuthStore(hostHome, isolatedHome);

      assert.equal(fs.existsSync(path.join(isolatedHome, ...LINUX_STORE)), false);
      assert.equal(fs.existsSync(path.join(isolatedHome, ...MACOS_STORE)), false);
    } finally {
      cleanup();
    }
  });

  it("does nothing when the isolated HOME is the host HOME", () => {
    const { hostHome, cleanup } = makeHomes();
    try {
      const hostStore = makeStore(hostHome, MACOS_STORE);

      linkHostKiroAuthStore(hostHome, hostHome);

      assert.ok(!fs.lstatSync(hostStore).isSymbolicLink(), "host store must stay a real directory");
    } finally {
      cleanup();
    }
  });

  it("keeps an existing entry and is safe to call twice", () => {
    const { hostHome, isolatedHome, cleanup } = makeHomes();
    try {
      makeStore(hostHome, MACOS_STORE);

      linkHostKiroAuthStore(hostHome, isolatedHome);
      linkHostKiroAuthStore(hostHome, isolatedHome);

      assert.ok(fs.lstatSync(path.join(isolatedHome, ...MACOS_STORE)).isSymbolicLink());
    } finally {
      cleanup();
    }
  });
});
