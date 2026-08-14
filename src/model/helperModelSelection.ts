import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { isNonEmptyString } from '@utils/core';

/**
 * Validate a configured helper-model choice against a candidate list, falling
 * back to the built-in default when the configured model isn't present. The
 * built-in default is always accepted as-is because it is used for internal
 * auxiliary tasks, not user-facing generation — do not fall back to the
 * first picker model, which is a premium default.
 *
 * Single source of truth for the "validate against candidates, else fall
 * back" precedence chain shared by {@link getHelperModelName} (agent runtime)
 * and settings / CLI enable-disable flows. An empty `candidateModels` always
 * falls through to `DEFAULT_HELPER_MODEL` here — this function does not
 * implement "no restriction" semantics. A caller that wants an empty list to
 * mean "accept the configured model as-is" must short-circuit before calling.
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
  return DEFAULT_HELPER_MODEL;
}
