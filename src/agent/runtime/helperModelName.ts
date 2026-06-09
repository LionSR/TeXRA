import { platform } from '@platform/platform';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { isNonEmptyString } from '@utils/core';

/**
 * Resolve the configured helper model name from global state.
 *
 * When the user has explicitly configured a helper model, validate it against
 * the enabled model list and fall back to the first enabled model if the
 * configured one was removed. The built-in default is always accepted because
 * it is used for internal auxiliary tasks, not user-facing generation.
 */
export function getHelperModelName(): string {
  const configuredModel = platform().globalState.get<string>(
    GlobalStateKey.HELPER_MODEL,
  );
  if (!isNonEmptyString(configuredModel)) {
    return DEFAULT_HELPER_MODEL;
  }

  const resolved = configuredModel.trim();
  if (resolved === DEFAULT_HELPER_MODEL) return resolved;

  const enabledModels = platform().globalState.get<string[]>(
    GlobalStateKey.ENABLED_MODELS,
    [],
  );
  if (enabledModels.length === 0 || enabledModels.includes(resolved)) {
    return resolved;
  }
  return enabledModels[0];
}
