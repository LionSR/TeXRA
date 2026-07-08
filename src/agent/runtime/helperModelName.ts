import { platform } from '@platform/platform';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { isNonEmptyString } from '@utils/core';

/**
 * Validate a configured helper-model choice against a candidate list, falling
 * back to the candidate list's first entry, and finally to the built-in
 * default, when the configured model isn't present in the list. The built-in
 * default is always accepted as-is because it is used for internal auxiliary
 * tasks, not user-facing generation.
 *
 * Single source of truth for the "validate against candidates, else fall
 * back" precedence chain shared by {@link getHelperModelName} (below) and
 * `SettingsModelSelectionController.getEffectiveHelperModel`. Callers own
 * what candidate list — and whether an empty candidate list means "no
 * restriction" or "fall back" — they pass in; see `getHelperModelName` for
 * that deliberate divergence.
 */
export function resolveEffectiveHelperModel(
  configuredModel: string | undefined,
  candidateModels: readonly string[],
): string {
  if (!isNonEmptyString(configuredModel)) {
    return DEFAULT_HELPER_MODEL;
  }

  const resolved = configuredModel.trim();
  if (resolved === DEFAULT_HELPER_MODEL) return resolved;

  if (candidateModels.includes(resolved)) {
    return resolved;
  }
  return candidateModels[0] ?? DEFAULT_HELPER_MODEL;
}

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
  // An empty/unset enabled-model list means "no restriction" here: accept the
  // configured model as-is. This differs from the Settings UI, whose candidate
  // list (`getVisibleModels()`) already substitutes `DEFAULT_MODELS` before it
  // ever reaches `resolveEffectiveHelperModel`, so it never sees an empty list.
  if (enabledModels.length === 0) {
    return resolved;
  }
  return resolveEffectiveHelperModel(resolved, enabledModels);
}
