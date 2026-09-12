/**
 * The helper model: one configured "helper model" setting behind session
 * descriptions, instruction polishing, AI-assisted agent creation and the
 * LaTeX text connector. Every use is one non-streaming turn, text in, text
 * out; the model is bound through the same route the run loop binds under.
 *
 * Helper turns are unmetered: no ledger row and no usage log, as before.
 */
import { Data, Effect, Schedule, type Scope } from 'effect';

import {
  getModelUnavailableReason,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { AgentCategory } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

import { getHelperModelName } from './helperModelName';
import { turnText } from './ModelInvoker';
import { bindModel, type BoundModel } from './run/modelBinding';
import { classifyModelFailure } from './run/modelFailure';

/** The configured helper model cannot serve right now (no key, disabled). */
export class HelperModelUnavailable extends Data.TaggedError(
  'HelperModelUnavailable',
)<{ readonly reason: string }> {}

/**
 * Bind the configured helper model into the caller's scope.
 *
 * `stores` are the process secret store and global state the caller already
 * holds (the `Secrets` / `AppState` services, or the stores a host root
 * threaded down), so helper resolution reads the same stores as the run that
 * asked for it. A helper has no persisted conversation format and no launch
 * async-local frame; it never takes the tool-use output haircut.
 */
export const helperModel = Effect.fn('helperModel')(function* (
  stores: ModelOptionStores,
): Effect.fn.Return<
  BoundModel,
  HelperModelUnavailable | Error,
  Scope.Scope
> {
  const modelName = getHelperModelName(stores.globalState);
  const reason = yield* Effect.tryPromise({
    try: () => getModelUnavailableReason(modelName, stores),
    catch: ensureError,
  });
  if (reason) return yield* new HelperModelUnavailable({ reason });
  const config = yield* Effect.tryPromise({
    try: () => resolveRuntimeModelConfig(modelName),
    catch: ensureError,
  });
  if (!config) {
    return yield* new HelperModelUnavailable({
      reason: `Model "${modelName}" is not recognized.`,
    });
  }
  return yield* bindModel({
    config,
    stores,
    compatibilityKey: null,
    agentCategory: AgentCategory.Workflow,
    // Helper calls are deterministic one-shots, never sampled.
    temperature: 0,
    inScope: (operation) => operation(),
  });
});

/** A single non-streaming helper-model text completion. */
export interface HelperPrompt {
  /** User message content. */
  readonly userPrompt: string;
  /** Optional system prompt. */
  readonly systemPrompt?: string;
}

/**
 * The bounded retry helper turns run under: they execute outside the run's
 * `ModelInvoker`, so they keep their own two attempts over provider errors
 * the runtime classifies as automatically retryable.
 */
const HELPER_RETRY = Schedule.exponential('500 millis', 2).pipe(
  Schedule.jittered,
);
const HELPER_RETRIES = 2;

/** One non-streaming completion on a bound helper model: its text. */
export const helperCompletion = Effect.fn('helperCompletion')(function* (
  bound: BoundModel,
  { userPrompt, systemPrompt }: HelperPrompt,
): Effect.fn.Return<string, Error> {
  const resolved = yield* bound.model.prepareTurn({
    ...(systemPrompt === undefined ? {} : { system: systemPrompt }),
    messages: [{ role: 'user', content: [{ kind: 'text', text: userPrompt }] }],
  });
  if (resolved.mode !== 'foreground') {
    return yield* Effect.fail(
      new Error('A helper turn prepared as background work.'),
    );
  }
  const turn = yield* bound.model.generateTurn(resolved).pipe(
    Effect.retry({
      schedule: HELPER_RETRY,
      times: HELPER_RETRIES,
      while: (error) => classifyModelFailure(error).autoRetryable,
    }),
  );
  return turnText(turn);
});
