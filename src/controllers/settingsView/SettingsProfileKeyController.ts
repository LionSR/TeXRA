// Third-party imports
import { Cause, Effect, Exit } from 'effect';

// Local imports - secrets
import { storeCredential } from '@common/secrets/storeCredential';
// Local imports - hosts
import type { ExternalOpener, PromptHost } from '@hosts/uiHosts';
// Local imports - model
import { apiKeySecretName, isApiProvider } from '@model/apiProviders';
// Local imports - platform
import type { PlatformSecrets } from '@platform/secrets';
// Local imports - utilities
import { ensureError } from '@utils/errors/errorMessage';

interface SettingsProfileKeyControllerDeps {
  /** The process secret store the host holds, where the keys are written. */
  secrets: PlatformSecrets;
  prompt: Pick<PromptHost, 'input' | 'info' | 'confirm'>;
  externalOpener: Pick<ExternalOpener, 'openExternal'>;
  getProviderDisplayName(provider: string): string;
  getProviderKeyUrl(provider: string): string | undefined;
  refreshAfterKeyChange(provider: string): Promise<void>;
  /**
   * Show a failed key action to the user. Required: a rejected placeholder or
   * an unknown provider must never fail silently on any host.
   */
  reportFailure(message: string, error: unknown): Promise<void>;
}

/**
 * Canonical "commit/remove a provider key" logic, shared by every surface
 * that lets a user set or remove an API key (settingsView's Profile tab and
 * the main webview's API key banner). Each surface injects its own prompt
 * flow, refresh behavior, and failure presentation; validation, the
 * write/delete/confirm/notify sequence, and the secret-store naming live here
 * once so they can't drift between surfaces.
 *
 * The key actions are `Effect`s because the credential store is: the write
 * itself is the store's own program, with its commit region uninterruptible
 * (host-controller study Q2), and the host settles the action at its own
 * boundary. The prompt, refresh, and reporting ports are still
 * Promise-shaped, so each is one `Effect.tryPromise` whose rejection becomes
 * the `Error` this controller reports, exactly as the `try/catch` around them
 * did.
 */
export class SettingsProfileKeyController {
  constructor(private readonly deps: SettingsProfileKeyControllerDeps) {}

  setProviderKey(provider: string): Effect.Effect<void> {
    return this.run(
      provider,
      'set',
      Effect.gen({ self: this }, function* () {
        const apiKey = yield* this.fromPort(() =>
          this.deps.prompt.input({
            prompt: `Enter ${this.deps.getProviderDisplayName(provider)} API key`,
            password: true,
            placeHolder: '************************************',
          }),
        );
        if (apiKey == null) return false;
        return yield* this.storeProviderKey(provider, apiKey);
      }),
    );
  }

  commitProviderKey(provider: string, apiKey: string): Effect.Effect<void> {
    return this.run(provider, 'set', this.storeProviderKey(provider, apiKey));
  }

  removeProviderKey(provider: string): Effect.Effect<void> {
    return this.run(
      provider,
      'remove',
      Effect.gen({ self: this }, function* () {
        const displayName = this.deps.getProviderDisplayName(provider);
        const confirmed = yield* this.fromPort(() =>
          this.deps.prompt.confirm(
            `Remove the ${displayName} API key? This cannot be undone.`,
            { confirmLabel: 'Remove', cancelLabel: 'Cancel', modal: false },
          ),
        );
        if (!confirmed) return false;

        yield* this.deps.secrets.delete(yield* secretNameFor(provider));
        yield* this.notify(`${displayName} API key has been removed`);
        return true;
      }),
    );
  }

  async openProviderKeyUrl(provider: string): Promise<void> {
    const url = this.deps.getProviderKeyUrl(provider);
    if (url) {
      await this.deps.externalOpener.openExternal(url);
    }
  }

  private storeProviderKey(
    provider: string,
    apiKey: string,
  ): Effect.Effect<boolean, Error> {
    return Effect.gen({ self: this }, function* () {
      const displayName = this.deps.getProviderDisplayName(provider);
      yield* storeCredential(this.deps.secrets, {
        secretName: yield* secretNameFor(provider),
        value: apiKey,
        kind: 'provider',
        label: displayName,
      });
      yield* this.notify(`${displayName} API key has been set`);
      return true;
    });
  }

  /**
   * Run one key action, then refresh. A failure of either — a rejected
   * placeholder, an unknown provider, a credential store that could not
   * write, a host that could not prompt — is reported to the user rather than
   * raised: every caller of this controller is a message handler with nowhere
   * to put an error.
   */
  private run(
    provider: string,
    verb: 'set' | 'remove',
    action: Effect.Effect<boolean, Error>,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const changed = yield* Effect.exit(action);
      if (Exit.isFailure(changed)) {
        yield* this.report(
          `Failed to ${verb} ${this.deps.getProviderDisplayName(provider)} API key`,
          Cause.squash(changed.cause),
        );
        return;
      }
      if (!changed.value) return;

      const refreshed = yield* Effect.exit(
        this.fromPort(() => this.deps.refreshAfterKeyChange(provider)),
      );
      if (Exit.isFailure(refreshed)) {
        const gerund = verb === 'set' ? 'setting' : 'removing';
        yield* this.report(
          `Failed to refresh after ${gerund} ${this.deps.getProviderDisplayName(provider)} API key`,
          Cause.squash(refreshed.cause),
        );
      }
    });
  }

  /** One call of a still-Promise-shaped host port, failing as an `Error`. */
  private fromPort<A>(call: () => Promise<A>): Effect.Effect<A, Error> {
    return Effect.tryPromise({ try: call, catch: ensureError });
  }

  /**
   * Tell the user a key changed. Best-effort by design and unawaited, as it
   * was: the write already happened, and a toast that cannot be shown must
   * not turn a successful key change into a reported failure.
   */
  private notify(message: string): Effect.Effect<void> {
    return Effect.sync(() => {
      void this.deps.prompt.info(message);
    });
  }

  /** Surface a failed action. A host that cannot report dies with it. */
  private report(message: string, error: unknown): Effect.Effect<void> {
    return Effect.promise(() => this.deps.reportFailure(message, error));
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
