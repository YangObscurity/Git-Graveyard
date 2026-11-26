import {
  createPermissionBroker,
  PermissionBroker,
  PermissionBrokerOptions,
} from "../../lib/broker/permission-broker";

export interface RequiredBrokerSettings extends PermissionBrokerOptions {
  watchdogLimitMs: number;
  settings: {
    watchdogLimitMs: number;
    [key: string]: unknown;
  };
  additionalDirectories?: string[];
}

/**
 * Returns required permission broker settings:
 * watchdog limit 5000 milliseconds, and optional allowed directories.
 */
export function getRequiredBrokerSettings(
  allowedDirectories?: string[]
): RequiredBrokerSettings {
  const config: RequiredBrokerSettings = {
    watchdogLimitMs: 5000,
    settings: {
      watchdogLimitMs: 5000,
    },
  };
  if (allowedDirectories !== undefined) {
    config.additionalDirectories = allowedDirectories;
  }
  return config;
}

/**
 * Convenience helper to construct a test PermissionBroker with required settings.
 */
export function createTestPermissionBroker(
  options: PermissionBrokerOptions = {}
): PermissionBroker {
  return createPermissionBroker({
    ...getRequiredBrokerSettings(options.additionalDirectories),
    ...options,
    settings: {
      watchdogLimitMs: 5000,
      ...(options.settings ?? {}),
    },
  });
}
