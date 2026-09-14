/**
 * Shared "prefer my subscription" config switch used by ChatGPT and Grok.
 *
 * Off by default (experimental, opt-in). Provider modules supply only the
 * config key; read/write semantics stay identical.
 */
import { Effect } from 'effect';
import { workspaceRoots } from '@platform/workspaceRoots';

import type { ConfigTarget, StoreWriteFailed } from '@platform/interfaces';

export interface SubscriptionPreferenceUpdate {
  readonly effective: boolean;
  readonly target: ConfigTarget;
}

interface SubscriptionPreference {
  isPrefer(): boolean;
  setPrefer(
    enabled: boolean,
  ): Effect.Effect<SubscriptionPreferenceUpdate, StoreWriteFailed>;
}

/** Build a prefer-subscription switch for a single config key. */
export function createSubscriptionPreference(
  configKey: string,
): SubscriptionPreference {
  function isPrefer(): boolean {
    return workspaceRoots().config.get<boolean>(configKey, false);
  }

  const setPrefer = Effect.fn('subscriptionPreference.setPrefer')(function* (
    enabled: boolean,
  ) {
    const { config } = workspaceRoots();

    const inspection = config.inspect<boolean>(configKey);
    const target: ConfigTarget =
      inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
    yield* config.update(configKey, enabled, target);
    return {
      effective: isPrefer(),
      target,
    } satisfies SubscriptionPreferenceUpdate;
  });

  return { isPrefer, setPrefer };
}
