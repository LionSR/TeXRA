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

/** True when any provider has a usable API key in secret storage or the environment. */
function hasAnyUsableProviderApiKey(
  secrets: PlatformSecrets,
  onProbeFailure: (message: string) => void,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    for (const provider of API_PROVIDERS) {
      // Keep the scan sequential so the first usable key ends the lookup.
      const hasApiKey = yield* probeSetupCredential(
        hasUsableApiKey(secrets, provider).pipe(
          Effect.mapError(setupCredentialProbeFailed(`${provider} API key`)),
        ),
        onProbeFailure,
      );
      if (hasApiKey) return true;
    }
    return false;
  });
}

/**
 * One credential check could not be answered: the subscription probe rejected,
 * or the credential store could not be read. Each check mints it for its own
 * kind through {@link setupCredentialProbeFailed}, so the recovery below is a
 * match on the one failure a probe can report rather than a blanket catch over
 * an untyped channel.
 */
export class SetupCredentialProbeFailed extends Data.TaggedError(
  'SetupCredentialProbeFailed',
)<{
  readonly kind: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Mint {@link SetupCredentialProbeFailed} for one kind of credential check. */
export const setupCredentialProbeFailed =
  (kind: string) =>
  (cause: unknown): SetupCredentialProbeFailed =>
    new SetupCredentialProbeFailed({
      kind,
      message: `${kind} check failed; treating it as no credential: ${toErrorMessage(cause)}`,
      cause,
    });

/**
 * A probe failure is treated as no credential of that kind. The caller owns
 * reporting so this model-layer policy stays free of logging side effects.
 * Interruption is not a probe failure: it cancels the scan rather than
 * answering it, which is why the recovery matches the failure tag rather
 * than every exit.
 *
 * `check` is the credential program itself, typed with the one failure a
 * probe reports: a check whose own failure is already typed (a provider key
 * read) maps it, and one that is still a host promise mints it at its own
 * call.
 */
export function probeSetupCredential(
  check: Effect.Effect<boolean, SetupCredentialProbeFailed>,
  onProbeFailure: (message: string) => void,
): Effect.Effect<boolean> {
  return check.pipe(
    Effect.catchTag('SetupCredentialProbeFailed', (failure) =>
      Effect.sync(() => {
        onProbeFailure(failure.message);
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
      Effect.tryPromise({
        try: () => isCodexSubscriptionActive(CHATGPT_SETUP_MODEL),
        catch: setupCredentialProbeFailed('ChatGPT subscription'),
      }),
      onProbeFailure,
    );
    if (hasChatGptSubscription) return true;
    const hasGrokSubscription = yield* probeSetupCredential(
      Effect.tryPromise({
        try: () => isXaiSubscriptionActive(XAI_SETUP_MODEL),
        catch: setupCredentialProbeFailed('Grok subscription'),
      }),
      onProbeFailure,
    );
    if (hasGrokSubscription) return true;
    return yield* hasAnyUsableProviderApiKey(secrets, onProbeFailure);
  });
}
