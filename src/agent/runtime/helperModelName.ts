import { getEnabledModels } from '@model/computeModelOptions';
import { resolveEffectiveHelperModel } from '@model/helperModelSelection';
import { platform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';

/**
 * Resolve the configured helper model name from global state.
 *
 * The configured helper model counts only while it is enabled; otherwise the
 * built-in default applies. The built-in default is always accepted because it
 * is used for internal auxiliary tasks, not user-facing generation. The
 * Settings UI resolves the same chain over the same enabled list.
 */
export function getHelperModelName(): string {
  return resolveEffectiveHelperModel(
    platform().globalState.get<string>(GlobalStateKey.HELPER_MODEL),
    getEnabledModels(),
  );
}
