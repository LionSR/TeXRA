import { Effect, Equal, Schema } from 'effect';

// Local imports
import {
  hasUsableApiKey,
  isApiProvider,
  apiKey,
  providerDisplayName,
  type ApiKeyProviderId,
} from '@texra-ai/llm';
import { type Session } from '@texra-ai/harness';
import { Secrets } from '@texra-ai/harness/host';
import type { ProcessServices } from '@texra-ai/harness/host';
import { Rejected, Unavailable } from '@texra-ai/harness/schemas';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import {
  isRequestRefusal,
  type RequestRefusal,
} from '@texra/controllers/session/hostCallFailure';

/**
 * The host could not ask the user for a provider key.
 *
 * One reason, by measurement: every implementation puts the request in front
 * of the user through the host's own surface (the extension runs its set-key
 * command, the desktop opens the Models tab, the TUI its key form), and
 * either that surface accepts the request or it faults. A user who closes the
 * prompt without entering a key is not a failure of the prompt: the
 * controller re-reads the store and says the retry did not switch.
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
  ): Effect.Effect<void, ApiKeyPromptFailed, ProcessServices>;
  /** The session holding the retry: its view says whether the retry still
   *  waits, and the decision lands through its requests. */
  readonly session: Pick<Session, 'request'> & {
    readonly view: Pick<Session['view'], 'current'>;
  };
}

/**
 * A retry's move onto the user's own credential, the same on every host.
 * Which provider and whether a changed key is required are the run's
 * decision, carried on the retry request; this makes sure that key exists
 * and then finishes the retry on it.
 */
export class ProgressApiKeyRetryController {
  private readonly deps: ProgressApiKeyRetryControllerDeps;
  constructor(deps: ProgressApiKeyRetryControllerDeps) {
    this.deps = deps;
  }

  /**
   * Switch this retry onto the user's own key and relaunch it. A retry
   * another surface answered meanwhile is left alone; one the user gave no
   * usable key for fails with a `Rejected` saying so, and stays pending.
   */
  readonly useOwnApiKey = Effect.fn(
    'ProgressApiKeyRetryController.useOwnApiKey',
  )(function* (
    this: ProgressApiKeyRetryController,
    request: Extract<HostCommand, { kind: 'useOwnApiKey' }>,
  ) {
    const { runId, requestId, credentialSwitch } = request;
    const { provider } = credentialSwitch;
    const proceeded = yield* this.ensureOwnApiKey(
      provider,
      credentialSwitch.kind === 'new-key',
    );
    const pending = this.deps.session.view
      .current()
      .requests.some(
        (r) =>
          r.runId === runId &&
          r.requestId === requestId &&
          r.payload.kind === 'retry',
      );
    if (!pending) return;
    if (!proceeded) {
      return yield* new Rejected({
        reason: `The retry did not switch to your own ${providerDisplayName(provider)} API key: no usable key was entered. Add one, then retry with your own key again.`,
      });
    }

    // The decision is the whole switch: the run reads `credentials:
    // 'personal'` off its own run history and declines the exhausted route for
    // itself when it rebinds. No preference of the user's is rewritten, so
    // two runs falling back at once cannot undo each other's choice. A
    // refused decision leaves the retry pending, and fails with the refusal.
    yield* this.deps.session
      .request({
        kind: 'request.decide',
        runId,
        requestId,
        decision: { action: 'retry', credentials: 'personal' },
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError((error): RequestRefusal =>
          isRequestRefusal(error)
            ? error
            : new Unavailable({
                runId,
                reason: 'The retry could not be settled.',
              }),
        ),
      );
  });

  /**
   * Whether the user has (or has just entered) a usable key for `provider`.
   * Upstream credit depletion means the stored key is the broken credential,
   * so only a changed key counts. A subscription quota does not break the
   * stored key, so an existing one is consent enough and the prompt appears
   * only when there is none.
   */
  private readonly ensureOwnApiKey = Effect.fn(
    'ProgressApiKeyRetryController.ensureOwnApiKey',
  )(function* (
    this: ProgressApiKeyRetryController,
    provider: ApiKeyProviderId,
    requireNewKey: boolean,
  ) {
    const secrets = yield* Secrets;
    if (requireNewKey) {
      const { value: before } = yield* apiKey(secrets, provider);
      yield* this.deps.promptForApiKey(provider);
      const { value: after } = yield* apiKey(secrets, provider);
      // Sealed values are compared by `Equal`, never unwrapped: this only
      // needs to know whether the credential changed, not what it is.
      return after !== undefined && !Equal.equals(after, before);
    }
    if (yield* hasUsableApiKey(secrets, provider)) return true;
    yield* this.deps.promptForApiKey(provider);
    return yield* hasUsableApiKey(secrets, provider);
  });
}
