import { Data, Effect } from 'effect';

import { apiKeySecretName, isApiProvider } from '@texra-ai/llm';
import { storeCredential } from '@texra/common/secrets/storeCredential';
import type { PromptFailed, PromptHost } from '@texra/hosts/uiHosts';
import { getProviderDisplayName } from '@texra/model/providerPresentation';
import type {
  StateReadFailed,
  PlatformSecrets,
  SettingsStores,
} from '@texra-ai/harness';

interface SettingsProfileKeyControllerDeps {
  /** The process secret store the host holds, where the keys are written. */
  secrets: PlatformSecrets;
  prompt: Pick<PromptHost, 'input' | 'info' | 'confirm'>;
  /** The setting slots a provider's display name is read from. */
  stores: SettingsStores;
}

/**
 * A key write or removal that failed. A committed change repaints nothing
 * here: every host's secret store publishes `credentialChanged`, and each
 * credential surface follows that signal.
 */
export class ProviderKeyActionFailed extends Data.TaggedError(
  'ProviderKeyActionFailed',
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Shared provider-key policy; hosts present failures at their own entry. */
export class SettingsProfileKeyController {
  constructor(private readonly deps: SettingsProfileKeyControllerDeps) {}

  setProviderKey(
    provider: string,
  ): Effect.Effect<void, ProviderKeyActionFailed | StateReadFailed> {
    return this.run(
      provider,
      'set',
      Effect.gen({ self: this }, function* () {
        const apiKey = yield* this.deps.prompt.input({
          prompt: `Enter ${yield* getProviderDisplayName(this.deps.stores, provider)} API key`,
          password: true,
          placeHolder: '************************************',
        });
        if (apiKey == null) return;
        yield* this.storeProviderKey(provider, apiKey);
      }),
    );
  }

  commitProviderKey(
    provider: string,
    apiKey: string,
  ): Effect.Effect<void, ProviderKeyActionFailed | StateReadFailed> {
    return this.run(provider, 'set', this.storeProviderKey(provider, apiKey));
  }

  removeProviderKey(
    provider: string,
  ): Effect.Effect<void, ProviderKeyActionFailed | StateReadFailed> {
    return this.run(
      provider,
      'remove',
      Effect.gen({ self: this }, function* () {
        const displayName = yield* getProviderDisplayName(
          this.deps.stores,
          provider,
        );
        const confirmed = yield* this.deps.prompt.confirm(
          `Remove the ${displayName} API key? This cannot be undone.`,
          { confirmLabel: 'Remove', modal: false },
        );
        if (!confirmed) return;

        yield* this.deps.secrets.delete(yield* secretNameFor(provider));
        yield* this.notify(`${displayName} API key has been removed`);
      }),
    );
  }

  private storeProviderKey(
    provider: string,
    apiKey: string,
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const displayName = yield* getProviderDisplayName(
        this.deps.stores,
        provider,
      );
      yield* storeCredential(this.deps.secrets, {
        secretName: yield* secretNameFor(provider),
        value: apiKey,
        kind: 'provider',
        label: displayName,
      });
      yield* this.notify(`${displayName} API key has been set`);
    });
  }

  /** Name a failed action after its provider; interruption propagates. */
  private run(
    provider: string,
    verb: 'set' | 'remove',
    action: Effect.Effect<void, Error | PromptFailed>,
  ): Effect.Effect<void, ProviderKeyActionFailed | StateReadFailed> {
    return Effect.gen({ self: this }, function* () {
      const label = yield* getProviderDisplayName(this.deps.stores, provider);
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
  }

  /**
   * Tell the user a key changed. Best-effort by design and not awaited, as it
   * was: the write already happened, a host notice can stay on screen long
   * after the action that raised it, and a toast that cannot be shown must not
   * turn a successful key change into a reported failure, so it is logged
   * rather than reported. The notice is a
   * detached fiber rather than a discarded `Effect` — an `Effect` nobody runs
   * shows nothing at all — started on this frame so it is posted before the
   * action returns.
   */
  private notify(message: string): Effect.Effect<void> {
    return this.deps.prompt.info(message).pipe(
      Effect.ignore({
        log: 'Warn',
        message: 'The key-change notice could not be shown.',
      }),
      Effect.forkDetach({ startImmediately: true }),
      Effect.asVoid,
    );
  }
}

/**
 * The credential store's name for a provider's key. An unknown provider is a
 * failure of the action, reported like any other, never a thrown defect.
 */
function secretNameFor(provider: string): Effect.Effect<string, Error> {
  return isApiProvider(provider)
    ? Effect.succeed(apiKeySecretName(provider))
    : Effect.fail(new Error(`Unknown API provider: ${provider}`));
}
