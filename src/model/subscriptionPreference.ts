/**
 * Shared "prefer my subscription" config switch used by ChatGPT and Grok.
 *
 * Off by default (experimental, opt-in). Provider modules supply only the
 * config key; read/write semantics stay identical.
 */
import { workspaceRoots } from '@platform/workspaceRoots';

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
    return workspaceRoots().config.get<boolean>(configKey, false);
  }

  async function setPrefer(
    enabled: boolean,
  ): Promise<SubscriptionPreferenceUpdate> {
    const { config } = workspaceRoots();

    const inspection = config.inspect<boolean>(configKey);
    const target: ConfigTarget =
      inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
    await config.update(configKey, enabled, target);
    return { effective: isPrefer(), target };
  }

  return { isPrefer, setPrefer };
}
