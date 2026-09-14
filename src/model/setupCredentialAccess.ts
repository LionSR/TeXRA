import { Data, Effect } from 'effect';

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
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * A credential probe that could not answer. It never leaves this module:
 * {@link probeSetupCredential} reports it and answers "no credential of that
 * kind", which is the policy below. The tag exists so the probe's own
 * `Effect.tryPromise` carries a typed failure rather than `unknown` while the
 * checks it calls are still Promise-shaped.
 */
class SetupCredentialProbeFailed extends Data.TaggedError(
  'SetupCredentialProbeFailed',
)<{
  readonly kind: string;
  readonly cause: unknown;
}> {}

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
        () => hasUsableApiKey(secrets, provider),
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
 * answering it, which is why the recovery matches the tag rather than every
 * exit.
 */
export function probeSetupCredential(
  kind: string,
  check: () => Promise<boolean>,
  onProbeFailure: (message: string) => void,
): Effect.Effect<boolean> {
  return Effect.tryPromise({
    try: check,
    catch: (cause) => new SetupCredentialProbeFailed({ kind, cause }),
  }).pipe(
    Effect.catch((failure) =>
      Effect.sync(() => {
        onProbeFailure(
          `${failure.kind} check failed; treating it as no credential: ${toErrorMessage(failure.cause)}`,
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
      () => isCodexSubscriptionActive(CHATGPT_SETUP_MODEL),
      onProbeFailure,
    );
    if (hasChatGptSubscription) return true;
    const hasGrokSubscription = yield* probeSetupCredential(
      'Grok subscription',
      () => isXaiSubscriptionActive(XAI_SETUP_MODEL),
      onProbeFailure,
    );
    if (hasGrokSubscription) return true;
    return yield* hasAnyUsableProviderApiKey(secrets, onProbeFailure);
  });
}
