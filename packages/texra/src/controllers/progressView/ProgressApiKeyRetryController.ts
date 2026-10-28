import { Effect, Equal, Schema } from 'effect';

// Local imports
import {
  hasUsableApiKey,
  isApiProvider,
  lookupApiKey,
  type ApiKeyProviderId,
} from '@texra-ai/llm';
import { type RequestRefusal } from '@texra-ai/harness';
import { Secrets } from '@texra-ai/harness/host';
import type { RunId } from '@texra-ai/harness/schemas';

interface ProgressApiKeyRetryRequest {
  stream: RunId;
  requestId: string;
  /** The key the retry will run on, as the run's offer names it. */
  provider: ApiKeyProviderId;
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
export class ApiKeyPromptFailed extends Schema.TaggedError<ApiKeyPromptFailed>()(
  'ApiKeyPromptFailed',
  {
    provider: Schema.String.pipe(Schema.refine(isApiProvider)),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

interface ProgressApiKeyRetryControllerDeps {
  /** Ask the user for the key; the prompt writes to the `Secrets` store
   *  this controller re-reads. */
  promptForApiKey(
    provider: ApiKeyProviderId,
  ): Effect.Effect<void, ApiKeyPromptFailed, Secrets>;
  isRetryPending(stream: RunId, requestId: string): boolean;
  /** Settles the retry on the user's own key; a refusal fails it, for the
   *  host arm that took the request to present. */
  triggerRetry(
    stream: RunId,
    requestId: string,
  ): Effect.Effect<void, RequestRefusal>;
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
    // 'personal'` off its own run history and declines the exhausted route for
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
    provider: ApiKeyProviderId,
    requireNewKey: boolean,
  ) {
    const secrets = yield* Secrets;
    if (requireNewKey) {
      const before = yield* lookupApiKey(secrets, provider);
      yield* this.deps.promptForApiKey(provider);
      const after = yield* lookupApiKey(secrets, provider);
      // Sealed values are compared by `Equal`, never unwrapped: this only
      // needs to know whether the credential changed, not what it is.
      return after !== undefined && !Equal.equals(after, before);
    }
    if (yield* hasUsableApiKey(secrets, provider)) return true;
    yield* this.deps.promptForApiKey(provider);
    return yield* hasUsableApiKey(secrets, provider);
  });
}
