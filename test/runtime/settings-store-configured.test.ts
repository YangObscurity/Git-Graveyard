// Required_Settings gate activation: a lazily created default settings store must not, by its mere
// existence, turn the gate on. Only explicit configuration or an actually stored setting does.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getDefaultSettingsStore,
  resetDefaultSettingsStore,
} from "@/lib/admin/settings-store";
import { isSettingsStoreConfigured, resolveSettingsStore } from "@/lib/runtime/store-context";

describe("isSettingsStoreConfigured with the lazily created shared store", () => {
  let tmpDir = "";
  const saved = {
    path: process.env.SETTINGS_STORE_PATH,
    nodeEnv: process.env.NODE_ENV,
  };

  beforeEach(() => {
    resetDefaultSettingsStore();
    delete process.env.SETTINGS_STORE_PATH;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-settings-configured-"));
  });

  afterEach(() => {
    resetDefaultSettingsStore();
    if (saved.path === undefined) delete process.env.SETTINGS_STORE_PATH;
    else process.env.SETTINGS_STORE_PATH = saved.path;
    (process.env as Record<string, string | undefined>).NODE_ENV = saved.nodeEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is not configured just because a route resolved the default store", () => {
    getDefaultSettingsStore({ path: path.join(tmpDir, "settings.db") });
    // A read-only resolution, as the Admin session check does, must not change the answer.
    resolveSettingsStore();
    assert.equal(isSettingsStoreConfigured(), false);
  });

  it("is not configured by internal state such as admin session revocations", () => {
    const store = getDefaultSettingsStore({ path: path.join(tmpDir, "settings.db") });
    store.setSetting("admin.revokedSessions", { sessions: [] }, { actor: "admin-session" });
    assert.equal(isSettingsStoreConfigured(), false);
  });

  it("is configured once a setting has been written to the shared store", () => {
    const store = getDefaultSettingsStore({ path: path.join(tmpDir, "settings.db") });
    store.setSetting("queueDepth", 3, { actor: "owner" });
    assert.equal(isSettingsStoreConfigured(), true);
  });

  it("is configured when SETTINGS_STORE_PATH is set, even with an empty store", () => {
    process.env.SETTINGS_STORE_PATH = path.join(tmpDir, "explicit.db");
    getDefaultSettingsStore();
    assert.equal(isSettingsStoreConfigured(), true);
  });
});
