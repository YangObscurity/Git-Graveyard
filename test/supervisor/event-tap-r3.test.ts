import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { EventStore } from "../../lib/events/event-store";
import {
  EventTap,
  SupervisorEventTap,
} from "../../lib/supervisor/event-tap";

describe("lib/supervisor/event-tap-r3: M-10 secret registry and autoRegisterEnvSecrets", () => {
  const originalAdminKey = process.env.ADMIN_KEY;
  const originalKiroKey = process.env.KIRO_API_KEY;

  beforeEach(() => {
    delete process.env.ADMIN_KEY;
    delete process.env.KIRO_API_KEY;
  });

  afterEach(() => {
    if (originalAdminKey !== undefined) {
      process.env.ADMIN_KEY = originalAdminKey;
    } else {
      delete process.env.ADMIN_KEY;
    }
    if (originalKiroKey !== undefined) {
      process.env.KIRO_API_KEY = originalKiroKey;
    } else {
      delete process.env.KIRO_API_KEY;
    }
  });

  it("reads the secret registry at each use, reflecting secrets registered after construction", async () => {
    const eventStore = new EventStore(":memory:");
    const tap = new SupervisorEventTap({
      runId: "run-r3-reg",
      skeletonId: "skel-test",
      taskId: "T-r3",
      eventStore,
      autoRegisterEnvSecrets: false,
    });

    const dynamicSecret = "live_registered_secret_alpha_999";

    // Before registration, secret is not redacted
    const textBefore = `Value: ${dynamicSecret}`;
    assert.equal(tap.redactText(textBefore), textBefore);

    // Register secret dynamically after construction
    tap.registerSecret(dynamicSecret);

    // At next use, secret registry is read and secret is redacted
    const textAfter = tap.redactText(textBefore);
    assert.ok(!textAfter.includes(dynamicSecret));
    assert.ok(textAfter.includes("[REDACTED]"));

    // Also check via processUpdate
    const updates = await tap.processUpdate({
      sessionUpdate: "agent_message",
      text: `Reporting secret: ${dynamicSecret}`,
    });
    assert.equal(updates.length, 1);
    const logText = String(updates[0].data.text);
    assert.ok(!logText.includes(dynamicSecret));
    assert.ok(logText.includes("[REDACTED]"));

    // Multiple secrets registration
    const secretB = "live_secret_beta_888";
    const secretC = "live_secret_gamma_777";
    tap.registerSecrets([secretB, secretC]);

    const multiText = tap.redactText(`Secrets: ${secretB} and ${secretC}`);
    assert.ok(!multiText.includes(secretB));
    assert.ok(!multiText.includes(secretC));
    assert.ok(multiText.includes("[REDACTED]"));

    // Verify secret registry getters
    const registry = tap.getSecretRegistry();
    assert.ok(registry.includes(dynamicSecret));
    assert.ok(registry.includes(secretB));
    assert.ok(registry.includes(secretC));

    tap.close();
  });

  it("dynamically reads environment secrets at each use when autoRegisterEnvSecrets is on", async () => {
    const eventStore = new EventStore(":memory:");
    // Constructed before ADMIN_KEY exists in process.env
    const tap = new SupervisorEventTap({
      runId: "run-r3-env",
      skeletonId: "skel-test",
      taskId: "T-r3",
      eventStore,
    });

    const runtimeEnvSecret = "runtime_env_admin_secret_4567";

    // Set environment variable dynamically after construction
    process.env.ADMIN_KEY = runtimeEnvSecret;

    // Tap reads environment secrets on each use
    const text = `Admin key: ${runtimeEnvSecret}`;
    const redacted = tap.redactText(text);
    assert.ok(!redacted.includes(runtimeEnvSecret), "Runtime env secret must be redacted on call");
    assert.ok(redacted.includes("[REDACTED]"));

    // Process update also redacts dynamically set env secret
    const updates = await tap.processUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call-dyn-env",
      tool: "sandbox_exec",
      arguments: { cmd: `echo ${runtimeEnvSecret}` },
    });
    const serialized = JSON.stringify(updates[0]);
    assert.ok(!serialized.includes(runtimeEnvSecret));
    assert.ok(serialized.includes("[REDACTED]"));

    tap.close();
  });

  it("makes env secret registration an explicit setting whose default is on", () => {
    const tapDefault = new SupervisorEventTap();
    assert.equal(tapDefault.isAutoRegisterEnvSecretsEnabled(), true, "Default autoRegisterEnvSecrets must be on (true)");

    const tapExplicitOn = new SupervisorEventTap({ autoRegisterEnvSecrets: true });
    assert.equal(tapExplicitOn.isAutoRegisterEnvSecretsEnabled(), true);

    const tapExplicitOff = new SupervisorEventTap({ autoRegisterEnvSecrets: false });
    assert.equal(tapExplicitOff.isAutoRegisterEnvSecretsEnabled(), false, "Explicit autoRegisterEnvSecrets: false must disable it");

    // When disabled, environment secret is not redacted
    const secret = "unregistered_env_secret_12345";
    process.env.ADMIN_KEY = secret;

    const input = `Admin: ${secret}`;
    const resultOff = tapExplicitOff.redactText(input);
    assert.equal(resultOff, input, "When autoRegisterEnvSecrets is disabled, env secret should not be auto-redacted");

    // When switched back on explicitly via setter
    tapExplicitOff.setAutoRegisterEnvSecrets(true);
    assert.equal(tapExplicitOff.isAutoRegisterEnvSecretsEnabled(), true);
    const resultOn = tapExplicitOff.redactText(input);
    assert.ok(!resultOn.includes(secret));
    assert.ok(resultOn.includes("[REDACTED]"));

    tapDefault.close();
    tapExplicitOn.close();
    tapExplicitOff.close();
  });
});
