import { Effect } from 'effect';
import { getEnabledModels } from '@model/computeModelOptions';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';

/**
 * The helper model a run, a merge, or the Models tab uses: the configured
 * choice while it is enabled, else the built-in default. The built-in default
 * is always accepted because it is used for internal auxiliary tasks, not
 * user-facing generation; never fall back to the first picker model, which is
 * a premium default. An empty enabled list falls through to the default too.
 *
 * The one resolution of the chain: every surface that shows or uses the
 * helper model reads it here, from the setting slots the caller holds.
 */
export function getHelperModelName(stores: SettingsStores) {
  return Effect.gen(function* () {
    const configured = (yield* readSettingFrom<string>(
      stores,
      GlobalStateKey.HELPER_MODEL,
    )).trim();
    if (configured === DEFAULT_HELPER_MODEL) return configured;
    const enabled = yield* getEnabledModels(stores.globalState);
    return enabled.includes(configured) ? configured : DEFAULT_HELPER_MODEL;
  });
}
