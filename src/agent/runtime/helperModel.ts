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
  modelUnavailableReasonFrom,
  readModelAvailabilityInputs,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import type { LanguageModel } from '@platform/languageModel';
import { AgentCategory } from '@shared/schemas';

import { getHelperModelName } from './helperModelName';
import { bindModel, type BoundModel } from './run/modelBinding';
import { classifyModelFailure } from './run/modelFailure';
import { turnText } from './run/turnText';
import type { HttpClient } from 'effect/unstable/http';

/**
 * The configured helper model cannot serve right now (no key, disabled,
 * unknown name). An expected state, not a defect: callers degrade quietly.
 */
export class HelperModelUnavailable extends Data.TaggedError(
  'HelperModelUnavailable',
)<{ readonly message: string }> {}

/**
 * Bind the configured helper model into the caller's scope.
 *
 * `stores` are the secret store and the three setting slots the caller
 * already holds (a session's `roots` plus the `Secrets` service, or the stores
 * a host root threaded down), so helper resolution, the model toggles and the
 * OpenRouter preference all read the same stores as the run that asked for it.
 * A helper has no persisted conversation format; it never takes the tool-use
 * output haircut.
 */
export const helperModel = Effect.fn('helperModel')(function* (
  stores: ModelOptionStores,
): Effect.fn.Return<
  BoundModel,
  HelperModelUnavailable | Error,
  Scope.Scope | LanguageModel | HttpClient.HttpClient
> {
  const modelName = yield* getHelperModelName(stores.globalState);
  const inputs = yield* readModelAvailabilityInputs(stores, [modelName]);
  const reason = modelUnavailableReasonFrom(inputs, modelName);
  if (reason) return yield* new HelperModelUnavailable({ message: reason });
  const config = getRuntimeModelConfig(modelName);
  if (!config) {
    return yield* new HelperModelUnavailable({
      message: `Model "${modelName}" is not recognized.`,
    });
  }
  return yield* bindModel({
    config,
    stores,
    compatibilityKey: null,
    agentCategory: AgentCategory.Workflow,
    // Helper calls are deterministic one-shots, never sampled.
    temperature: 0,
  });
});

/** A single non-streaming helper-model text completion. */
interface HelperPrompt {
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
      // Stamped with the bound route, as the loop stamps its own attempts:
      // SuperGrok and Kimi Code share their API-key host, so without it an
      // exhausted plan's 429 reads as an ordinary rate limit and the helper
      // repeats a request that cannot succeed.
      while: (error) =>
        classifyModelFailure(error, bound.usageRoute).autoRetryable,
    }),
  );
  // The turn's assistant text, from the same leaf the run loop reads.
  return turnText(turn);
});
