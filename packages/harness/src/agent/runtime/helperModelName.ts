import { Effect } from 'effect';
import { modelRefOf } from '@texra-ai/llm';
import { withLogChannel } from '@logger/effectLog';
import { getEnabledModels, readModelOptions } from '@model/computeModelOptions';
import { Settings } from '@shared/config/settings';
import type { SettingsStores } from '@shared/config/settings';
import { HELPER_MODEL_SETTING } from '@shared/state/stateSettings';

const CHANNEL = 'helperModel';

/**
 * The helper model a run, a merge, or the Models tab uses: the configured
 * choice while it is enabled, else the catalog's default for the setting;
 * `undefined` when neither names one, and a run's helper calls use its own
 * model. The harness names no default: an app's catalog supplies its own
 * (`settingsCatalog`'s `defaults`). That default is always accepted because it
 * serves internal auxiliary tasks, not user-facing generation; a disabled
 * choice falls back to it, never to the first picker model, which is a
 * premium default.
 *
 * The one resolution of the chain: every surface that shows or uses the
 * helper model reads it here, from the setting slots the caller holds.
 */
export const getHelperModelName = Effect.fn('getHelperModelName')(function* (
  stores: SettingsStores,
) {
  const configured = (yield* Settings.get(
    stores,
    HELPER_MODEL_SETTING,
  ))?.trim();
  const fallback = Settings.defaultOf(
    stores.config.catalog,
    HELPER_MODEL_SETTING,
  );
  if (configured === undefined || configured === fallback) return fallback;
  const enabled = yield* getEnabledModels(stores);
  return enabled.includes(modelRefOf(configured) ?? configured)
    ? configured
    : fallback;
});

/**
 * The model a helper task runs on: the helper model ({@link getHelperModelName})
 * while it can serve, else `fallback`, the model the asking run or launch
 * already has. A user who can reach only that model's provider still gets
 * the helper task without the setting being rewritten for them; the swap is
 * logged. With no helper model the answer is `fallback`, and with neither
 * `undefined`.
 *
 * The one decision for both helper uses: a launch that opts in with
 * `helperModel` (small, quick fix-up actions a host runs off the user's
 * heavyweight model) and a helper call (`helperCall`). `stores` are the
 * setting slots the caller holds, so the preference and the availability
 * answer are read from the same stores as the run itself.
 */
export const servableHelperModel = Effect.fn('servableHelperModel')(function* (
  stores: SettingsStores,
  fallback: string | undefined,
) {
  const helperModel = yield* getHelperModelName(stores);
  if (helperModel === undefined) return fallback;
  if (fallback === undefined || fallback === helperModel) return helperModel;
  const [option] = yield* readModelOptions(stores, [helperModel]);
  const unavailable = option?.unavailableReason;
  if (!unavailable) return helperModel;
  yield* Effect.logWarning(
    `Using ${fallback}: helper model ${helperModel} is unavailable. ${unavailable}`,
  ).pipe(withLogChannel(CHANNEL));
  return fallback;
});
