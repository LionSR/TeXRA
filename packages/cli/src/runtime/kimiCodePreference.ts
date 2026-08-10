import {
  stateSettingByKey,
  type StateSettingEntry,
} from '@shared/schemas';
import {
  writeSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { cliSettingsStores } from './settingsStores';

function cliProviderRoutingSetting(key: GlobalStateKey): StateSettingEntry {
  const entry = stateSettingByKey(key);
  if (!entry) {
    throw new Error(`CLI state-setting catalog is missing "${key}".`);
  }
  return entry;
}

/**
 * Single owner of the "Prefer Kimi Code" write and its OpenRouter mutual
 * exclusion: dual-backend Kimi routing refuses the OpenRouter toggle, so
 * enabling the preference also turns that toggle off (disabling leaves it
 * untouched). `/api kimi-code` and the `/config` form both route through here
 * so the coupling cannot drift between surfaces. Callers own the model-options
 * cache invalidation and TUI view refresh.
 */
export async function setKimiCodePreference(
  enabled: boolean,
  stores: SettingsStores = cliSettingsStores(),
): Promise<void> {
  await writeSetting(
    cliProviderRoutingSetting(GlobalStateKey.KIMI_CODE_PREFER),
    enabled,
    stores,
    'cli',
  );
  if (enabled) {
    await writeSetting(
      cliProviderRoutingSetting(GlobalStateKey.USE_OPENROUTER),
      false,
      stores,
      'cli',
    );
  }
}
