import { Effect } from 'effect';

import { hasUsableApiKey } from '@model/apiProviders';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
  usageRouteFrom,
} from '@model/computeModelOptions';
import { SETUP_MODEL_BY_PROVIDER } from '@model/setupModelDefaults';
import type { LanguageModel } from '@platform/languageModel';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { isModelOptionAvailable } from '@shared/schemas';
import { getUseOpenRouter } from '@utils/config/providerConfig';

/**
 * The setup assistant's launch model: the first provider setup model the
 * picker reports available, preferring one a subscription pays for. A
 * provider's setup model counts only on that provider's own credential, so
 * another provider's model riding OpenRouter never stands in for OpenRouter's
 * own setup model.
 *
 * `includeAccessListFallback` offers OpenRouter's setup model while the
 * OpenRouter switch is off, as a last resort: the extension prompts first and
 * turns the switch on for that launch (`requiresOpenRouter`), while desktop
 * has no prompt to explain the flip and opts out.
 */
export const resolveSetupLaunchModel = Effect.fn('resolveSetupLaunchModel')(
  function* (
    stores: SettingsStores,
    secrets: PlatformSecrets,
    includeAccessListFallback: boolean,
  ) {
    const candidates = Object.entries(SETUP_MODEL_BY_PROVIDER);
    const inputs = yield* readModelAvailabilityInputs(
      { ...stores, secrets },
      candidates.map(([, model]) => model),
    );
    const options = modelOptionsFrom(inputs);
    const runnable = options.filter(
      (option, index) =>
        isModelOptionAvailable(option) &&
        (option.availability === 'openrouter-key') ===
          (candidates[index]?.[0] === 'openRouter'),
    );
    const pick =
      runnable.find((option) => usageRouteFrom(inputs, option.value)) ??
      runnable[0];
    if (pick) {
      return {
        model: pick.value,
        requiresOpenRouter: pick.availability === 'openrouter-key',
      };
    }
    if (!includeAccessListFallback || (yield* getUseOpenRouter(stores))) {
      return null;
    }
    return (yield* hasUsableApiKey(secrets, 'openRouter'))
      ? { model: SETUP_MODEL_BY_PROVIDER.openRouter, requiresOpenRouter: true }
      : null;
  },
);

/**
 * True when the setup assistant has a model to launch with, the OpenRouter
 * last resort included. A check that cannot be answered is logged and read as
 * no credential, so a broken store sends the user to onboarding instead of
 * failing the gate.
 */
export function hasUsableSetupCredential(
  stores: SettingsStores,
  secrets: PlatformSecrets,
): Effect.Effect<boolean, never, LanguageModel> {
  return resolveSetupLaunchModel(stores, secrets, true).pipe(
    Effect.map((resolution) => resolution !== null),
    Effect.catch((failure) =>
      Effect.logWarning(
        `Setup credential check failed; treating it as no credential: ${failure.message}`,
      ).pipe(Effect.as(false)),
    ),
  );
}
