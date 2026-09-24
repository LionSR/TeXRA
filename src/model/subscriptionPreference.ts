/**
 * Shared "prefer my subscription" config switch used by ChatGPT and Grok.
 *
 * Off by default (experimental, opt-in). Provider modules supply only the
 * config key; read/write semantics stay identical.
 */
import { Effect } from 'effect';

import type { ConfigTarget, ConfigWriteFailed } from '@platform/interfaces';
import {
  readConfigSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';
import { settingByKey } from '@shared/state/stateSettings';
import { writeSettingTo } from '@utils/config/platformSettings';

interface SubscriptionPreference {
  isPrefer(stores: SettingsStores): boolean;
  /**
   * Persist the preference in the scope that controls it. An `Effect`, so the
   * caller's program owns the write and its failure rather than receiving a
   * rejection it cannot compose. The value read back is always `enabled`:
   * every host's config is a two-layer `JsonConfigProvider`, and the write
   * lands in the layer that wins, so no more specific setting can override it.
   */
  setPrefer(
    stores: SettingsStores,
    enabled: boolean,
  ): Effect.Effect<void, ConfigWriteFailed | Error>;
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
    const entry = settingByKey(configKey);
    if (!entry)
      throw new Error(`No setting catalog entry for key: ${configKey}`);
    return readConfigSetting(entry, stores.config) as boolean;
  }

  function setPrefer(
    stores: SettingsStores,
    enabled: boolean,
  ): Effect.Effect<void, ConfigWriteFailed | Error> {
    // The scope that currently controls the value: a project that already
    // names the preference keeps owning it, everyone else writes the user
    // file. Passed to the catalog write path as the explicit target, so the
    // row's schema still validates the value.
    const inspection = stores.config.inspect<boolean>(configKey);
    const target: ConfigTarget =
      inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
    return writeSettingTo(stores, configKey, enabled, target);
  }

  return { isPrefer, setPrefer };
}
