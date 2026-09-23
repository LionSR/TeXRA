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
import type { LanguageModel } from '@platform/languageModel';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** True when any provider has a usable API key in secret storage or the environment. */
function hasAnyUsableProviderApiKey(
  secrets: PlatformSecrets,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    for (const provider of API_PROVIDERS) {
      // Keep the scan sequential so the first usable key ends the lookup.
      const hasApiKey = yield* probeSetupCredential(
        hasUsableApiKey(secrets, provider).pipe(
          Effect.mapError(setupCredentialProbeFailed(`${provider} API key`)),
        ),
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
 * A probe failure is treated as no credential of that kind and logged as a
 * warning; the caller names the log channel. Interruption is not a probe failure: it cancels the scan rather than
 * answering it, which is why the recovery matches the failure tag rather
 * than every exit.
 *
 * `check` is the credential program itself, typed with the one failure a
 * probe reports: a check whose own failure is already typed (a provider key
 * read, a subscription probe) maps it to the tag at its own call.
 */
export function probeSetupCredential<R>(
  check: Effect.Effect<boolean, SetupCredentialProbeFailed, R>,
): Effect.Effect<boolean, never, R> {
  return check.pipe(
    Effect.catchTag('SetupCredentialProbeFailed', (failure) =>
      Effect.logWarning(failure.message).pipe(Effect.as(false)),
    ),
  );
}

/**
 * The signed-in setup subscription's model, in host-shared priority order:
 * ChatGPT/Codex first, then Grok. The one ladder both the setup gate below and
 * the setup model picker read, so the priority order and the probe wiring
 * cannot come to disagree about which subscription the user has. A probe
 * failure is treated as no subscription of that kind and logged; `null`
 * when neither subscription is signed in.
 */
export function setupSubscriptionModel(
  stores: SettingsStores,
): Effect.Effect<string | null, never, LanguageModel> {
  return Effect.gen(function* () {
    const hasChatGptSubscription = yield* probeSetupCredential(
      isCodexSubscriptionActive(stores, CHATGPT_SETUP_MODEL).pipe(
        Effect.mapError(setupCredentialProbeFailed('ChatGPT subscription')),
      ),
    );
    if (hasChatGptSubscription) return CHATGPT_SETUP_MODEL;
    const hasGrokSubscription = yield* probeSetupCredential(
      isXaiSubscriptionActive(stores, XAI_SETUP_MODEL).pipe(
        Effect.mapError(setupCredentialProbeFailed('Grok subscription')),
      ),
    );
    return hasGrokSubscription ? XAI_SETUP_MODEL : null;
  });
}

/**
 * True when any setup credential is usable: a signed-in subscription, or an
 * API key of any provider. Each failed credential probe resolves to false
 * after being logged.
 */
export function hasUsableSetupCredential(
  stores: SettingsStores,
  secrets: PlatformSecrets,
): Effect.Effect<boolean, never, LanguageModel> {
  return Effect.gen(function* () {
    const subscriptionModel = yield* setupSubscriptionModel(stores);
    if (subscriptionModel !== null) return true;
    return yield* hasAnyUsableProviderApiKey(secrets);
  });
}
