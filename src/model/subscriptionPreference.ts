/**
 * Shared "prefer my subscription" config switch used by ChatGPT and Grok.
 *
 * Off by default (experimental, opt-in). Provider modules supply only the
 * config key; read/write semantics stay identical.
 */
import { Effect } from 'effect';

import { workspaceRoots } from '@platform/workspaceRoots';
import type { ConfigTarget, ConfigWriteFailed } from '@platform/interfaces';
import { readPlatformSetting } from '@utils/config/platformSettings';

export interface SubscriptionPreferenceUpdate {
  readonly effective: boolean;
  readonly target: ConfigTarget;
}

interface SubscriptionPreference {
  isPrefer(): boolean;
  /**
   * Persist the preference and report the scope it landed in. An `Effect`, so
   * the caller's program owns the write and its failure rather than receiving
   * a rejection it cannot compose.
   */
  setPrefer(
    enabled: boolean,
  ): Effect.Effect<SubscriptionPreferenceUpdate, ConfigWriteFailed>;
}

/** Build a prefer-subscription switch for a single config key. */
export function createSubscriptionPreference(
  configKey: string,
): SubscriptionPreference {
  function isPrefer(): boolean {
    return readPlatformSetting<boolean>(configKey);
  }

  function setPrefer(
    enabled: boolean,
  ): Effect.Effect<SubscriptionPreferenceUpdate, ConfigWriteFailed> {
    const { config } = workspaceRoots();

    const inspection = config.inspect<boolean>(configKey);
    const target: ConfigTarget =
      inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
    return config.update(configKey, enabled, target).pipe(
      // The effective value is read after the write: a store that refuses the
      // write never reaches it, and one that normalizes it is what the caller
      // sees.
      Effect.map(() => ({
        effective: readPlatformSetting<boolean>(configKey),
        target,
      })),
    );
  }

  return { isPrefer, setPrefer };
}
