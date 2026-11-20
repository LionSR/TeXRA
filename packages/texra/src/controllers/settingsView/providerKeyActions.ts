/**
 * Shared provider-key policy: every surface that sets or removes a provider's
 * API key goes through these, so the secret name, the confirmation and the
 * notice cannot drift between hosts. A host passes its own `dialogs` and
 * presents a failure at its own entry.
 */
import { Effect, Schema } from 'effect';

import { apiKeySecretName, isApiProvider } from '@texra-ai/llm';
import {
  Secrets,
  type SettingsStores,
  type StateReadFailed,
} from '@texra-ai/harness/plugins';
import { storeCredential } from '@texra/common/secrets/storeCredential';
import type { Dialogs, HostFailed } from '@texra/hosts/uiHosts';
import { getProviderDisplayName } from '@texra/model/providerPresentation';
import { PROVIDER_KEY_COPY } from '@ui/copy/credentials';

/**
 * A key write or removal that failed. A committed change repaints nothing
 * here: every host's secret store publishes `credentialChanged`, and each
 * credential surface follows that signal.
 */
export class ProviderKeyActionFailed extends Schema.TaggedError<ProviderKeyActionFailed>()(
  'ProviderKeyActionFailed',
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

type KeyAction = Effect.Effect<
  void,
  ProviderKeyActionFailed | StateReadFailed,
  Secrets
>;

/** Ask for `provider`'s key and store it; a dismissed prompt stores nothing.
 *  `stores` are the setting slots the provider's display name is read from. */
export const setProviderKey = (
  dialogs: Dialogs,
  stores: SettingsStores,
  provider: string,
): KeyAction =>
  named(
    stores,
    provider,
    'set',
    Effect.gen(function* () {
      const apiKey = yield* dialogs.input({
        prompt: PROVIDER_KEY_COPY.enter(
          yield* getProviderDisplayName(stores, provider),
        ),
        secret: true,
        placeholder: '************************************',
      });
      if (apiKey == null) return;
      yield* storeProviderKey(dialogs, stores, provider, apiKey);
    }),
  );

/** Store a key the calling surface already holds. */
export const commitProviderKey = (
  dialogs: Dialogs,
  stores: SettingsStores,
  provider: string,
  apiKey: string,
): KeyAction =>
  named(
    stores,
    provider,
    'set',
    storeProviderKey(dialogs, stores, provider, apiKey),
  );

/** Remove `provider`'s key once the user confirms. */
export const removeProviderKey = (
  dialogs: Dialogs,
  stores: SettingsStores,
  provider: string,
): KeyAction =>
  named(
    stores,
    provider,
    'remove',
    Effect.gen(function* () {
      const displayName = yield* getProviderDisplayName(stores, provider);
      const confirmed = yield* dialogs.confirm({
        message: `Remove the ${displayName} API key? This cannot be undone.`,
        action: 'Remove',
      });
      if (!confirmed) return;

      yield* (yield* Secrets).delete(yield* secretNameFor(provider));
      // The removal already happened; a toast that cannot be shown is logged
      // by the host, never a failed change.
      yield* dialogs.notify('info', `${displayName} API key has been removed`);
    }),
  );

const storeProviderKey = Effect.fn('providerKeyActions.storeProviderKey')(
  function* (
    dialogs: Dialogs,
    stores: SettingsStores,
    provider: string,
    apiKey: string,
  ) {
    const displayName = yield* getProviderDisplayName(stores, provider);
    yield* storeCredential(yield* Secrets, {
      secretName: yield* secretNameFor(provider),
      value: apiKey,
      kind: 'provider',
      label: displayName,
    });
    yield* dialogs.notify('info', `${displayName} API key has been set`);
  },
);

/** Name a failed action after its provider; interruption propagates. */
const named = Effect.fn('providerKeyActions.named')(function* (
  stores: SettingsStores,
  provider: string,
  verb: 'set' | 'remove',
  action: Effect.Effect<void, Error | HostFailed, Secrets>,
): Effect.fn.Return<void, ProviderKeyActionFailed | StateReadFailed, Secrets> {
  const label = yield* getProviderDisplayName(stores, provider);
  yield* action.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderKeyActionFailed({
          message: `Failed to ${verb} ${label} API key`,
          cause,
        }),
    ),
  );
});

/**
 * The credential store's name for a provider's key. An unknown provider is a
 * failure of the action, reported like any other, never a thrown defect.
 */
function secretNameFor(
  provider: string,
): Effect.Effect<string, ProviderKeyActionFailed> {
  return isApiProvider(provider)
    ? Effect.succeed(apiKeySecretName(provider))
    : Effect.fail(
        new ProviderKeyActionFailed({
          message: `Unknown API provider: ${provider}`,
          cause: undefined,
        }),
      );
}
