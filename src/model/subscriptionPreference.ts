/**
 * Shared "prefer my subscription" config switch used by ChatGPT and Grok.
 *
 * Off by default (experimental, opt-in). Provider modules supply only the
 * config key; read/write semantics stay identical.
 */
import { Effect } from 'effect';

import type { ConfigTarget, ConfigWriteFailed } from '@platform/interfaces';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  readSettingFrom,
  writeSettingTo,
} from '@utils/config/platformSettings';

export interface SubscriptionPreferenceUpdate {
  readonly effective: boolean;
  readonly target: ConfigTarget;
}

interface SubscriptionPreference {
  isPrefer(stores: SettingsStores): boolean;
  /**
   * Persist the preference and report the scope it landed in. An `Effect`, so
   * the caller's program owns the write and its failure rather than receiving
   * a rejection it cannot compose.
   */
  setPrefer(
    stores: SettingsStores,
    enabled: boolean,
  ): Effect.Effect<SubscriptionPreferenceUpdate, ConfigWriteFailed | Error>;
}

/**
 * Build a prefer-subscription switch for a single config key. Both halves take
 * the setting slots of the workspace they answer for, so the value a host reads
 * back is the one it just wrote.
 */
export function createSubscriptionPreference(
  configKey: string,
): SubscriptionPreference {
  function isPrefer(stores: SettingsStores): boolean {
    return readSettingFrom<boolean>(stores, configKey);
  }

  function setPrefer(
    stores: SettingsStores,
    enabled: boolean,
  ): Effect.Effect<SubscriptionPreferenceUpdate, ConfigWriteFailed | Error> {
    // The scope that currently controls the value: a project that already
    // names the preference keeps owning it, everyone else writes the user
    // file. Passed to the catalog write path as the explicit target, so the
    // row's schema still validates the value.
    const inspection = stores.config.inspect<boolean>(configKey);
    const target: ConfigTarget =
      inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
    return writeSettingTo(stores, configKey, enabled, target).pipe(
      // The effective value is read after the write: a store that refuses the
      // write never reaches it, and one that normalizes it is what the caller
      // sees.
      Effect.map(() => ({ effective: isPrefer(stores), target })),
    );
  }

  return { isPrefer, setPrefer };
}
