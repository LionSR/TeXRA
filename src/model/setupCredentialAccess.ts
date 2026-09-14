import { Effect } from 'effect';

import { API_PROVIDERS, hasUsableApiKey } from '@model/apiProviders';
import {
  isCodexSubscriptionActive,
  isXaiSubscriptionActive,
} from '@model/providerCapabilities';
import {
  CHATGPT_SETUP_MODEL,
  XAI_SETUP_MODEL,
} from '@model/setupModelDefaults';
import type { PlatformSecrets } from '@platform/secrets';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

/** True when any provider has a usable API key in secret storage or the environment. */
function hasAnyUsableProviderApiKey(
  secrets: PlatformSecrets,
  onProbeFailure: (message: string) => void,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    for (const provider of API_PROVIDERS) {
      // Keep the scan sequential so the first usable key ends the lookup.
      const hasApiKey = yield* probeSetupCredential(
        `${provider} API key`,
        hasUsableApiKey(secrets, provider),
        onProbeFailure,
      );
      if (hasApiKey) return true;
    }
    return false;
  });
}

/**
 * A probe failure is treated as no credential of that kind. The caller owns
 * reporting so this model-layer policy stays free of logging side effects.
 * Interruption is not a probe failure: it cancels the scan rather than
 * answering it, which is why the recovery matches the failure channel rather
 * than every exit.
 *
 * `check` is the credential program itself, so a check that already types its
 * own failure (a provider key read) hands it straight over, and one that is
 * still a host promise types it at its own call.
 */
export function probeSetupCredential(
  kind: string,
  check: Effect.Effect<boolean, unknown>,
  onProbeFailure: (message: string) => void,
): Effect.Effect<boolean> {
  return check.pipe(
    Effect.catch((cause) =>
      Effect.sync(() => {
        onProbeFailure(
          `${kind} check failed; treating it as no credential: ${toErrorMessage(cause)}`,
        );
        return false;
      }),
    ),
  );
}

/** Each failed credential probe resolves to false after being reported. */
export function hasUsableSetupCredential(
  secrets: PlatformSecrets,
  onProbeFailure: (message: string) => void,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const hasChatGptSubscription = yield* probeSetupCredential(
      'ChatGPT subscription',
      Effect.tryPromise({
        try: () => isCodexSubscriptionActive(CHATGPT_SETUP_MODEL),
        catch: ensureError,
      }),
      onProbeFailure,
    );
    if (hasChatGptSubscription) return true;
    const hasGrokSubscription = yield* probeSetupCredential(
      'Grok subscription',
      Effect.tryPromise({
        try: () => isXaiSubscriptionActive(XAI_SETUP_MODEL),
        catch: ensureError,
      }),
      onProbeFailure,
    );
    if (hasGrokSubscription) return true;
    return yield* hasAnyUsableProviderApiKey(secrets, onProbeFailure);
  });
}
