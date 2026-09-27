import { Data, Effect, Equal, Redacted } from 'effect';

// Local imports
import type { ApiProvider } from '@model/apiProviders';
import type { SecretsFailed } from '@platform/secrets';
import type { RunId } from '@shared/schemas';

interface ProgressApiKeyRetryRequest {
  stream: RunId;
  requestId: string;
  /** The key the retry will run on, as the run's offer names it. */
  provider: ApiProvider;
  /** The stored key is the broken credential: only a changed one proceeds. */
  requireNewKey: boolean;
}

/**
 * The host could not ask the user for a provider key.
 *
 * One reason, by measurement: both implementations put the request in front of
 * the user through the host's own surface (the extension runs its set-key
 * command, the desktop opens the Models tab and posts a notice), and either
 * that surface accepts the request or it faults. A user who closes the prompt
 * without entering a key is not a failure — the controller re-reads the store
 * and answers `false`.
 */
export class ApiKeyPromptFailed extends Data.TaggedError('ApiKeyPromptFailed')<{
  readonly provider: ApiProvider;
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface ProgressApiKeyRetryControllerDeps {
  readKey(
    provider: ApiProvider,
  ): Effect.Effect<Redacted.Redacted<string> | undefined, SecretsFailed>;
  hasUsableKey(provider: ApiProvider): Effect.Effect<boolean, SecretsFailed>;
  promptForApiKey(
    provider: ApiProvider,
  ): Effect.Effect<void, ApiKeyPromptFailed>;
  isRetryPending(stream: RunId, requestId: string): boolean;
  triggerRetry(stream: RunId, requestId: string): Effect.Effect<boolean>;
}

/**
 * The key-entry half of a retry's move onto the user's own credential. Which
 * provider and whether a changed key is required are the run's decision,
 * carried on the retry request; this only makes sure that key exists before
 * the retry is settled on it.
 */
export class ProgressApiKeyRetryController {
  constructor(private readonly deps: ProgressApiKeyRetryControllerDeps) {}

  /** Switch this retry onto the user's own key and relaunch it. The host
   *  arm that took the request runs this where it stands. */
  readonly useOwnApiKey = Effect.fn(
    'ProgressApiKeyRetryController.useOwnApiKey',
  )(function* (
    this: ProgressApiKeyRetryController,
    request: ProgressApiKeyRetryRequest,
  ) {
    const proceeded = yield* this.ensureOwnApiKey(
      request.provider,
      request.requireNewKey,
    );
    if (
      !proceeded ||
      !this.deps.isRetryPending(request.stream, request.requestId)
    ) {
      return;
    }

    // The decision is the whole switch: the run reads `credentials:
    // 'personal'` off its own ledger and declines the exhausted route for
    // itself when it rebinds. No preference of the user's is rewritten, so
    // two runs falling back at once cannot undo each other's choice.
    yield* this.deps.triggerRetry(request.stream, request.requestId);
  });

  /**
   * Whether the user has (or has just entered) a usable key for `provider`.
   * Upstream credit depletion means the stored key is the broken credential,
   * so only a changed key counts. A subscription quota does not break the
   * stored key, so an existing one is consent enough and the prompt appears
   * only when there is none.
   */
  readonly ensureOwnApiKey = Effect.fn(
    'ProgressApiKeyRetryController.ensureOwnApiKey',
  )(function* (
    this: ProgressApiKeyRetryController,
    provider: ApiProvider,
    requireNewKey: boolean,
  ) {
    if (requireNewKey) {
      const before = yield* this.deps.readKey(provider);
      yield* this.deps.promptForApiKey(provider);
      const after = yield* this.deps.readKey(provider);
      // Sealed values are compared by `Equal`, never unwrapped: this only
      // needs to know whether the credential changed, not what it is.
      return after !== undefined && !Equal.equals(after, before);
    }
    if (yield* this.deps.hasUsableKey(provider)) return true;
    yield* this.deps.promptForApiKey(provider);
    return yield* this.deps.hasUsableKey(provider);
  });
}
