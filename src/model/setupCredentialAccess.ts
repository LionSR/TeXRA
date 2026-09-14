import { Cause, Effect } from 'effect';

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
import { isNonEmptyString } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** True when any provider has a usable API key in secret storage or the environment. */
const hasAnyUsableProviderApiKey = Effect.fn(
  'setupCredentialAccess.hasAnyUsableProviderApiKey',
)(function* (
  secrets: PlatformSecrets,
  onProbeFailure: (message: string) => void,
) {
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

/**
 * A probe failure is treated as no credential of that kind. The caller owns
 * reporting so this model-layer policy stays free of logging side effects.
 */
export function probeSetupCredential<E>(
  kind: string,
  check: Effect.Effect<boolean, E>,
  onProbeFailure: (message: string) => void,
): Effect.Effect<boolean> {
  return check.pipe(
    Effect.catchCause((cause) => {
      onProbeFailure(
        `${kind} check failed; treating it as no credential: ${toErrorMessage(
          Cause.squash(cause),
        )}`,
      );
      return Effect.succeed(false);
    }),
  );
}

/** Each failed credential probe resolves to false after being reported. */
export const hasUsableSetupCredential = Effect.fn(
  'setupCredentialAccess.hasUsableSetupCredential',
)(function* (
  secrets: PlatformSecrets,
  onProbeFailure: (message: string) => void,
) {
  const hasChatGptSubscription = yield* probeSetupCredential(
    'ChatGPT subscription',
    Effect.promise(() => isCodexSubscriptionActive(CHATGPT_SETUP_MODEL)),
    onProbeFailure,
  );
  if (hasChatGptSubscription) return true;
  const hasGrokSubscription = yield* probeSetupCredential(
    'Grok subscription',
    Effect.promise(() => isXaiSubscriptionActive(XAI_SETUP_MODEL)),
    onProbeFailure,
  );
  if (hasGrokSubscription) return true;
  return yield* hasAnyUsableProviderApiKey(secrets, onProbeFailure);
});
