// Third-party imports
import { Cause, Effect, Exit } from 'effect';

// Local imports - secrets
import { storeCredential } from '@common/secrets/storeCredential';
// Local imports - hosts
import type {
  ExternalOpenFailed,
  ExternalOpener,
  PromptFailed,
  PromptHost,
} from '@hosts/uiHosts';
// Local imports - model
import { apiKeySecretName, isApiProvider } from '@model/apiProviders';
// Local imports - platform
import type { PlatformSecrets } from '@platform/secrets';

interface SettingsProfileKeyControllerDeps<R> {
  /** The process secret store the host holds, where the keys are written. */
  secrets: PlatformSecrets;
  prompt: Pick<PromptHost, 'input' | 'info' | 'confirm'>;
  externalOpener: Pick<ExternalOpener, 'openExternal'>;
  getProviderDisplayName(provider: string): string;
  getProviderKeyUrl(provider: string): string | undefined;
  refreshAfterKeyChange(provider: string): Effect.Effect<void, Error, R>;
  /**
   * Show a failed key action to the user. Required: a rejected placeholder or
   * an unknown provider must never fail silently on any host.
   */
  reportFailure(message: string, error: unknown): Effect.Effect<void, never, R>;
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
 * boundary. The prompt port is an `Effect` too, so a host that could not ask
 * for a key arrives as `PromptFailed` and is reported like any other failed
 * action. The refresh and reporting ports are programs too: each host's
 * key-dependent refresh and its failure notice are handed over as the
 * `Effect`s they already were, and this controller settles nothing — the
 * whole action is one program the host runs at its own message boundary.
 *
 * `R` is whatever those two host ports need from context (the language-model
 * bridge behind a model-availability repaint on both graphical hosts); it is
 * `never` for a host whose refresh needs nothing.
 */
export class SettingsProfileKeyController<R = never> {
  constructor(private readonly deps: SettingsProfileKeyControllerDeps<R>) {}

  setProviderKey(provider: string): Effect.Effect<void, never, R> {
    return this.run(
      provider,
      'set',
      Effect.gen({ self: this }, function* () {
        const apiKey = yield* this.deps.prompt.input({
          prompt: `Enter ${this.deps.getProviderDisplayName(provider)} API key`,
          password: true,
          placeHolder: '************************************',
        });
        if (apiKey == null) return false;
        return yield* this.storeProviderKey(provider, apiKey);
      }),
    );
  }

  commitProviderKey(
    provider: string,
    apiKey: string,
  ): Effect.Effect<void, never, R> {
    return this.run(provider, 'set', this.storeProviderKey(provider, apiKey));
  }

  removeProviderKey(provider: string): Effect.Effect<void, never, R> {
    return this.run(
      provider,
      'remove',
      Effect.gen({ self: this }, function* () {
        const displayName = this.deps.getProviderDisplayName(provider);
        const confirmed = yield* this.deps.prompt.confirm(
          `Remove the ${displayName} API key? This cannot be undone.`,
          { confirmLabel: 'Remove', cancelLabel: 'Cancel', modal: false },
        );
        if (!confirmed) return false;

        yield* this.deps.secrets.delete(yield* secretNameFor(provider));
        yield* this.notify(`${displayName} API key has been removed`);
        return true;
      }),
    );
  }

  openProviderKeyUrl(
    provider: string,
  ): Effect.Effect<void, ExternalOpenFailed> {
    const url = this.deps.getProviderKeyUrl(provider);
    return url ? this.deps.externalOpener.openExternal(url) : Effect.void;
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
   *
   * Cancellation is not one of those failures. `Effect.exit` absorbs an
   * interruption exactly as it absorbs a failure, so an interrupted action
   * would otherwise tell the user the key could not be set over a credential
   * the store's uninterruptible commit had already written. Each exit is
   * checked for interrupts and re-raised instead, which also skips the report
   * and the refresh below — both are host ports, and what interrupts these
   * fibers is the process runtime being disposed on the shutdown path, with
   * the surfaces they would repaint going away with it.
   *
   * Nothing durable is lost with them. The refresh writes nothing: it drops
   * the process's API-key lookup cache — five seconds of TTL, in memory, gone
   * with the process — and repaints host surfaces. The credential is already
   * on disk, and everything that has to outlive the fiber belongs to the
   * write path, where `saveProviderApiKey` and `UnsetApiKeyTool` carry their
   * post-commit steps as `Effect.ensuring` finalizers.
   */
  private run(
    provider: string,
    verb: 'set' | 'remove',
    action: Effect.Effect<boolean, Error | PromptFailed>,
  ): Effect.Effect<void, never, R> {
    return Effect.gen({ self: this }, function* () {
      const changed = yield* Effect.exit(action);
      if (Exit.isFailure(changed)) {
        if (Cause.hasInterrupts(changed.cause)) return yield* Effect.interrupt;
        yield* this.deps.reportFailure(
          `Failed to ${verb} ${this.deps.getProviderDisplayName(provider)} API key`,
          Cause.squash(changed.cause),
        );
        return;
      }
      if (!changed.value) return;

      const refreshed = yield* Effect.exit(
        this.deps.refreshAfterKeyChange(provider),
      );
      if (Exit.isFailure(refreshed)) {
        if (Cause.hasInterrupts(refreshed.cause)) {
          return yield* Effect.interrupt;
        }
        const gerund = verb === 'set' ? 'setting' : 'removing';
        yield* this.deps.reportFailure(
          `Failed to refresh after ${gerund} ${this.deps.getProviderDisplayName(provider)} API key`,
          Cause.squash(refreshed.cause),
        );
      }
    });
  }

  /**
   * Tell the user a key changed. Best-effort by design and not awaited, as it
   * was: the write already happened, a host notice can stay on screen long
   * after the action that raised it, and a toast that cannot be shown must not
   * turn a successful key change into a reported failure. The notice is a
   * detached fiber rather than a discarded `Effect` — an `Effect` nobody runs
   * shows nothing at all — started on this frame so it is posted before the
   * action returns.
   */
  private notify(message: string): Effect.Effect<void> {
    return this.deps.prompt
      .info(message)
      .pipe(
        Effect.ignore,
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
