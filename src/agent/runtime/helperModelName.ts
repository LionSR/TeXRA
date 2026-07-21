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
 * `SettingsModelSelectionController.getEffectiveHelperModel`. An empty
 * `candidateModels` always falls through to `DEFAULT_HELPER_MODEL` here —
 * this function does not implement "no restriction" semantics. A caller
 * that wants an empty list to mean "accept the configured model as-is"
 * must short-circuit before calling; see `getHelperModelName`'s
 * `enabledModels.length === 0` check for that deliberate divergence.
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
  const enabledModels = platform().globalState.get<string[]>(
    GlobalStateKey.ENABLED_MODELS,
    [],
  );

  // The only runtime-specific divergence from the shared precedence chain: an
  // empty/unset enabled-model list means "no restriction" here, so a
  // non-default configured model is accepted as-is. This differs from the
  // Settings UI, whose candidate list (`getVisibleModels()`) already
  // substitutes `DEFAULT_MODELS` before it ever reaches
  // `resolveEffectiveHelperModel`, so it never sees an empty list. Everything
  // else (empty/whitespace config, the built-in default, validate-against-
  // candidates, else fall back) defers to the single-source-of-truth chain.
  if (enabledModels.length === 0 && isNonEmptyString(configuredModel)) {
    const resolved = configuredModel.trim();
    if (resolved !== DEFAULT_HELPER_MODEL) return resolved;
  }

  return resolveEffectiveHelperModel(configuredModel, enabledModels);
}
