import { Effect } from 'effect';
import { modelConfig, modelRefOf } from '@texra-ai/llm';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { withLogChannel } from '@logger/effectLog';
import { getEnabledModels, readModelOptions } from '@model/computeModelOptions';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { Settings } from '@shared/config/settings';
import type { SettingsStores } from '@shared/config/settings';

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
export function getHelperModelName(stores: SettingsStores) {
  return Effect.gen(function* () {
    const configured = (yield* Settings.get<string | undefined>(
      stores,
      GlobalStateKey.HELPER_MODEL,
    ))?.trim();
    const fallback = Settings.defaultOf<string | undefined>(
      stores.config.catalog,
      GlobalStateKey.HELPER_MODEL,
    );
    if (configured === undefined || configured === fallback) return fallback;
    const enabled = yield* getEnabledModels(stores.globalState);
    return enabled.includes(modelRefOf(configured) ?? configured)
      ? configured
      : fallback;
  });
}

/**
 * Helper-model preference for launches that opt in with
 * `helperModel`: small, quick fix-up actions a host runs on the
 * configured helper model rather than the heavyweight model the user has
 * selected. Every other launch (a direct run, an orchestrator delegation)
 * leaves the flag off and keeps the chosen model.
 *
 * Swap `config`'s model for the configured helper model, or return it unchanged
 * when none is configured, the helper model already equals it, the helper
 * model can't call functions (the agent needs its tools), or the helper model
 * is unavailable.
 *
 * `stores` are the setting slots the launching run already holds, so the
 * preference and the availability answer are read from the same stores as
 * the run itself.
 */
export const applyHelperModelPreference = Effect.fn(
  'applyHelperModelPreference',
)(function* (config: AgentConfig, stores: SettingsStores) {
  const helperModel = yield* getHelperModelName(stores);
  if (helperModel === undefined || helperModel === config.model) return config;

  const helperModelConfig = modelConfig(helperModel);

  // The agent needs its tools, so do not assign a helper
  // model that does not declare function calling — not only one that
  // explicitly sets the capability to false.
  if (!helperModelConfig?.capabilities.supportsFunctionCalling) {
    yield* Effect.logWarning(
      `Keeping ${config.model} for ${config.agent}: helper model ${helperModel} does not support function calling.`,
    ).pipe(withLogChannel(CHANNEL));
    return config;
  }

  const [option] = yield* readModelOptions(stores, [helperModel]);
  const unavailable = option?.unavailableReason;
  if (unavailable) {
    yield* Effect.logWarning(
      `Keeping ${config.model} for ${config.agent}: helper model ${helperModel} is unavailable. ${unavailable}`,
    ).pipe(withLogChannel(CHANNEL));
    return config;
  }

  return { ...config, model: helperModel };
});
