import { resolveEffectiveHelperModel } from '@model/helperModelSelection';
import { platform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { isNonEmptyString } from '@utils/core';

/**
 * Resolve the configured helper model name from global state.
 *
 * When the user has explicitly configured a helper model, validate it against
 * the enabled model list and fall back to the built-in default if the
 * configured one was removed. The built-in default is always accepted because
 * it is used for internal auxiliary tasks, not user-facing generation.
 */
export function getHelperModelName(): string {
  const configuredModel = platform().globalState.get<string>(
    GlobalStateKey.HELPER_MODEL,
  );
  const enabledModels = platform().globalState.get<string[]>(
    GlobalStateKey.ENABLED_MODELS,
    [],
  );

  // The only runtime-specific divergence from the shared precedence chain: an
  // empty/unset enabled-model list means "no restriction" here, so the
  // configured model is accepted as-is. This differs from the Settings UI,
  // whose candidate list (`getVisibleModels()`) already substitutes
  // `DEFAULT_MODELS` before it ever reaches `resolveEffectiveHelperModel`, so
  // it never sees an empty list. Everything else (empty/whitespace config, the
  // built-in default, validate-against-candidates, else fall back) defers to
  // the single-source-of-truth chain.
  if (enabledModels.length === 0 && isNonEmptyString(configuredModel)) {
    return configuredModel.trim();
  }

  return resolveEffectiveHelperModel(configuredModel, enabledModels);
}
