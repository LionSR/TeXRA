/**
 * Shared "prefer my subscription" config switch used by ChatGPT and Grok.
 *
 * Off by default (experimental, opt-in). Provider modules supply only the
 * config key; read/write semantics stay identical.
 */
import { tryPlatform } from '@platform/platform';

import type { ConfigTarget } from '@platform/interfaces';

export interface SubscriptionPreferenceUpdate {
  readonly effective: boolean;
  readonly target: ConfigTarget;
}

interface SubscriptionPreference {
  isPrefer(): boolean;
  setPrefer(enabled: boolean): Promise<SubscriptionPreferenceUpdate>;
}

/** Build a prefer-subscription switch for a single config key. */
export function createSubscriptionPreference(
  configKey: string,
): SubscriptionPreference {
  function isPrefer(): boolean {
    return tryPlatform()?.config.get<boolean>(configKey, false) ?? false;
  }

  async function setPrefer(
    enabled: boolean,
  ): Promise<SubscriptionPreferenceUpdate> {
    const host = tryPlatform();
    if (!host) return { effective: false, target: 'global' };

    const inspection = host.config.inspect<boolean>(configKey);
    const target: ConfigTarget =
      inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
    await host.config.update(configKey, enabled, target);
    return { effective: isPrefer(), target };
  }

  return { isPrefer, setPrefer };
}
