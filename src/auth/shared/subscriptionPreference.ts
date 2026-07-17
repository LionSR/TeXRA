/**
 * Shared config plumbing for the per-provider "prefer my subscription" and
 * "subscription for tool-use only" switches (Codex/ChatGPT, Kimi Code). Each
 * provider module binds its own config keys and re-exports named wrappers; the
 * read/write-at-controlling-scope logic lives here once.
 */
import { tryPlatform } from '@platform/platform';

import type { ConfigTarget } from '@platform/interfaces';

export interface SubscriptionPreferenceUpdate {
  readonly effective: boolean;
  readonly target: ConfigTarget;
}

interface SubscriptionPreference {
  /** Whether the user has switched on "prefer subscription". */
  isPreferSubscription(): boolean;
  /** Whether the subscription is restricted to tool-use agents. */
  isToolUseOnly(): boolean;
  /** Update the preference at the scope that currently controls its value. */
  setPreferSubscription(
    enabled: boolean,
  ): Promise<SubscriptionPreferenceUpdate>;
  /** Update the "subscription for tool-use only" switch at the controlling scope. */
  setToolUseOnly(enabled: boolean): Promise<SubscriptionPreferenceUpdate>;
}

/** Read a boolean preference, defaulting to off before platform init. */
function readFlag(key: string): boolean {
  return tryPlatform()?.config.get<boolean>(key, false) ?? false;
}

function preferenceUpdateTarget(key: string): ConfigTarget {
  const inspection = tryPlatform()?.config.inspect<boolean>(key);
  return inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
}

/** Write a boolean preference at the scope that currently controls its value. */
async function writeFlag(
  key: string,
  enabled: boolean,
): Promise<SubscriptionPreferenceUpdate> {
  const host = tryPlatform();
  const target = preferenceUpdateTarget(key);
  if (!host) return { effective: false, target };

  await host.config.update(key, enabled, target);
  return { effective: readFlag(key), target };
}

/** Bind the four preference operations to one provider's config keys. */
export function createSubscriptionPreference(keys: {
  preferKey: string;
  toolUseOnlyKey: string;
}): SubscriptionPreference {
  return {
    isPreferSubscription: () => readFlag(keys.preferKey),
    isToolUseOnly: () => readFlag(keys.toolUseOnlyKey),
    setPreferSubscription: (enabled) => writeFlag(keys.preferKey, enabled),
    setToolUseOnly: (enabled) => writeFlag(keys.toolUseOnlyKey, enabled),
  };
}
