import { Effect } from 'effect';
import { modelConfig, modelRefOf } from '@texra-ai/llm';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { withLogChannel } from '@logger/effectLog';
import {
  getEnabledModels,
  readModelOptions,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import type { StateReadFailed } from '@platform/interfaces';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/defaultModels';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { Settings } from '@shared/config/settings';
import type { SettingsStores } from '@shared/config/settings';

const CHANNEL = 'helperModel';

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
export function getHelperModelName(
  stores: SettingsStores,
): Effect.Effect<string, StateReadFailed> {
  return Effect.gen(function* () {
    const configured = (yield* Settings.get<string>(
      stores,
      GlobalStateKey.HELPER_MODEL,
    )).trim();
    if (configured === DEFAULT_HELPER_MODEL) return configured;
    const enabled = yield* getEnabledModels(stores.globalState);
    return enabled.includes(modelRefOf(configured) ?? configured)
      ? configured
      : DEFAULT_HELPER_MODEL;
  });
}

/**
 * Helper-model preference for launches that opt in with
 * `preferHelperModel`: small, quick fix-up actions a host runs on the
 * configured helper model rather than the heavyweight model the user has
 * selected. Every other launch (a direct run, an orchestrator delegation)
 * leaves the flag off and keeps the chosen model.
 *
 * Swap `config`'s model for the configured helper model, or return it unchanged
 * when the helper model already equals it, the helper model can't call
 * functions (the agent needs its tools), or the helper model is unavailable.
 *
 * `stores` are the secret store and the session's setting slots the launching
 * run already holds, so the preference and the availability answer are read
 * from the same stores as the run itself.
 */
export const applyHelperModelPreference = Effect.fn(
  'applyHelperModelPreference',
)(function* (config: AgentConfig, stores: ModelOptionStores) {
  const helperModel = yield* getHelperModelName(stores);
  if (helperModel === config.model) return config;

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
